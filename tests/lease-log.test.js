'use strict';

// Contratto del sink diagnostico del lease lato servizio: eventi a enum chiusa,
// campi redati (nessun segreto), righe limitate (coalescing per motivo,
// dettaglio per-tentativo disattivato di default), sink guasto che non cambia
// l'esito, e cablaggio dal percorso servizio reale con cfg.log assente.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { LEASE_LOG_EVENTS, redactLeaseEvent, createLeaseLog, createDefaultWrite } = require('../lib/fleet/lease-log.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { loadOrCreateVerifier, signProof } = require('../lib/fleet/lease-verifier.js');
const { createServer } = require('../lib/server.js');

const PREFIX = 'cell-lease: ';

function sink() {
  const lines = [];
  return {
    lines,
    write: (line) => { lines.push(line); },
    events: () => lines.map((l) => JSON.parse(l.slice(PREFIX.length))),
  };
}

// Coppia server/client su un server TCP throwaway (come nelle suite lease).
function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const client = net.createConnection(srv.address().port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) { srv.close(() => {}); resolve({ serverSide: pending, client }); }
          else setTimeout(wait, 2);
        };
        wait();
      });
      client.once('error', reject);
    });
  });
}

function recv(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(to); client.removeListener('data', on); }
    function on(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) { cleanup(); resolve(msg); }
      }
    }
    client.on('data', on);
  });
}

const runDir = (home) => path.join(home, '.nexuscrew', 'run');

function setup(leaseLogWrite) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leaselog-'));
  const clock = { t: 10_000 };
  const timers = [];
  const mgr = createLeaseManager(
    { home, ...(leaseLogWrite ? { leaseLog: leaseLogWrite } : {}) },
    {
      now: () => clock.t,
      // La cancellazione e' EFFETTIVA: un handle cancellato non va eseguito.
      setTimeout: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return h; },
      clearTimeout: (h) => { if (h && typeof h === 'object') h.cancelled = true; },
    },
  );
  return { home, clock, timers, mgr };
}

async function attachWithProof(mgr, cellId, clock) {
  const info = await mgr.track(cellId);
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
  return { info, client, proof: ack.proof };
}

function forgeProof(home, clock, claims, { issuedAt = null } = {}) {
  const v = loadOrCreateVerifier({ dir: runDir(home) });
  // Contratto del signer: ogni campo firmato e' una stringa non vuota e il
  // jti e' fornito dal chiamante (come fa il percorso reale in issueLeaseProof).
  return signProof(v, {
    ...claims,
    generation: String(claims.generation),
    jti: crypto.randomBytes(8).toString('hex'),
    issuedAt: issuedAt == null ? clock.t : issuedAt,
  }, { now: () => clock.t });
}

function reconnect(stablePath, msg) {
  return new Promise((resolve, reject) => {
    const rc = net.createConnection(stablePath, () => {
      rc.write(`${JSON.stringify(msg)}\n`);
    });
    // Espone anche la socket: il chiamante puo' chiudere il canale riconnesso.
    recv(rc, (m) => m.type === 'lease' || m.type === 'deny').then((m) => resolve({ msg: m, sock: rc }), reject);
    rc.once('error', reject);
  });
}

async function untilNotLive(mgr, cellId, timeoutMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const st = mgr.status(cellId);
    if (st.state !== 'live') return st;
    if (Date.now() - t0 > timeoutMs) return st;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('enum chiusa: evento fuori contratto non produce riga', () => {
  assert.ok(Array.isArray(LEASE_LOG_EVENTS));
  assert.ok(LEASE_LOG_EVENTS.includes('denied'));
  assert.equal(redactLeaseEvent({ event: 'made-up', reason: 'x' }), null);
  assert.equal(redactLeaseEvent(null), null);
});

test('redazione: campi non in whitelist mai nell\'output, valori sporchi ridotti a redacted', () => {
  const secret = 'SUPER-SECRET-PROOF-1234567890';
  const out = redactLeaseEvent({
    event: 'denied', cell: 'alpha', gate: 'proof', reason: 'expired',
    ts: 1234,
    proof: secret, hmac: secret, token: secret, key: secret, env: { a: secret }, argv: ['x', secret],
  });
  assert.equal(out.event, 'denied');
  assert.equal(out.gate, 'proof');
  assert.equal(out.reason, 'expired');
  assert.equal(out.cell, 'alpha');
  assert.equal(out.ts, 1234);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('SUPER-SECRET'), 'nessun segreto nell\'evento redatto');
  assert.ok(!/(proof|hmac|token|key|env|argv)/.test(Object.keys(out).join(',')));

  // reason con contenuto arbitrario (charset chiuso) -> redacted, non propagato
  const poison = redactLeaseEvent({ event: 'denied', reason: `expired ${secret} ; drop`, ts: 1 });
  assert.equal(poison.reason, 'redacted');
  assert.ok(!JSON.stringify(poison).includes('SUPER-SECRET'));
  const tooLong = redactLeaseEvent({ event: 'eof', reason: 'a'.repeat(64), ts: 1 });
  assert.equal(tooLong.reason, 'redacted');
});

test('redazione: nessuna proprietà ereditata valutata né serializzata', () => {
  const canary = `CANARY-${'K'.repeat(512)}`;
  // Campi propri fuori contratto ottenuti da JSON.parse: constructor con un
  // oggetto lungo, __proto__, hasOwnProperty, toString. Nessuno deve essere
  // valutato (nessuna eccezione), nessuno deve comparire nell'output.
  const ev = JSON.parse(`{"event":"denied","gate":"proof","reason":"expired","ts":1,"constructor":{"blob":"${canary}"},"__proto__":{"z":1},"hasOwnProperty":1,"toString":1}`);
  let out = null;
  assert.doesNotThrow(() => { out = redactLeaseEvent(ev); }, 'nessun campo estraneo puo\' sollevare');
  assert.ok(out, 'l\'evento valido viene redatto');
  const flat = JSON.stringify(out);
  assert.ok(flat.length < 512, `riga limitata, non un dump: ${flat.length} byte`);
  assert.ok(!flat.includes('CANARY-'), 'nessun canary nell\'output');
  for (const k of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, k), `campo estraneo ${k} mai nell'output`);
  }
  // I controlli ordinari restano: campi ammessi invariati, segreti scartati.
  assert.equal(out.gate, 'proof');
  assert.equal(out.reason, 'expired');
  assert.equal(redactLeaseEvent({ event: 'denied', proof: 'X-SECRET' }).proof, undefined);
});

test('righe limitate: errori coalesciuti per motivo, attempt solo con dettaglio bounded', () => {
  const s = sink();
  const lg = createLeaseLog({ write: s.write });
  for (let i = 0; i < 5; i += 1) lg.log({ event: 'transport-error', reason: 'socket', ts: 1000 + i });
  for (let i = 0; i < 2; i += 1) lg.log({ event: 'denied', gate: 'proof', reason: 'expired', ts: 1100 + i });
  lg.log({ event: 'denied', gate: 'replay', reason: 'replay', ts: 1200 });
  lg.log({ event: 'reconnected', cell: 'alpha', generation: 0, ts: 1300 });
  for (let i = 0; i < 3; i += 1) lg.log({ event: 'attempt', cell: 'alpha', ts: 1400 + i });

  const ev = s.events();
  assert.equal(ev.filter((e) => e.event === 'transport-error').length, 1, 'stesso motivo -> una riga');
  assert.equal(ev.filter((e) => e.event === 'denied' && e.reason === 'expired').length, 1);
  assert.equal(ev.filter((e) => e.event === 'denied' && e.reason === 'replay').length, 1, 'motivo diverso -> riga propria');
  assert.equal(ev.filter((e) => e.event === 'reconnected').length, 1);
  assert.equal(ev.filter((e) => e.event === 'attempt').length, 0, 'dettaglio per-tentativo disattivato di default');

  const s2 = sink();
  const lg2 = createLeaseLog({ write: s2.write, detail: true, maxDetailLines: 2 });
  for (let i = 0; i < 4; i += 1) lg2.log({ event: 'attempt', cell: 'alpha', ts: 2000 + i });
  assert.equal(s2.events().length, 2, 'dettaglio bounded: massimo maxDetailLines righe');
});

test('sink guasto: nessuna eccezione propagata, con e senza dettaglio', () => {
  const lg = createLeaseLog({ write: () => { throw new Error('sink dead'); } });
  assert.doesNotThrow(() => lg.log({ event: 'terminal', cell: 'alpha', ts: 1 }));
  const lg2 = createLeaseLog({ write: () => { throw new Error('sink dead'); }, detail: true });
  assert.doesNotThrow(() => lg2.log({ event: 'attempt', cell: 'alpha', ts: 1 }));
  const lg3 = createLeaseLog({});
  assert.doesNotThrow(() => lg3.log({ event: 'lease-start', ts: 1 }));
});

test('manager senza cfg.log: eventi per nome (lease-start, eof, denied, reconnected, terminal)', async () => {
  const s = sink();
  const { home, clock, timers, mgr } = setup(s.write);
  try {
    await mgr.boot();
    let ev = s.events();
    assert.equal(ev.filter((e) => e.event === 'lease-start').length, 1, 'una riga di inizio al boot');

    const { info, client } = await attachWithProof(mgr, 'alpha', clock);
    await untilNotLive(mgr, 'alpha');
    client.destroy();
    await new Promise((r) => setTimeout(r, 30));
    ev = s.events();
    assert.equal(ev.filter((e) => e.event === 'eof' && e.cell === 'alpha').length, 1, 'EOF del canale -> eof');

    // proof scaduto: firmato nel passato, esce dal TTL -> denied gate proof
    const st = mgr.status('alpha');
    const stale = forgeProof(home, clock, {
      kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st.leaseId, generation: '0',
    }, { issuedAt: clock.t - 120_000 });
    const deny1 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: stale });
    assert.equal(deny1.msg.type, 'deny');
    ev = s.events();
    const denied = ev.filter((e) => e.event === 'denied');
    assert.equal(denied.length, 1, 'una riga denied');
    assert.equal(denied[0].gate, 'proof');
    assert.equal(denied[0].reason, 'expired');

    // la grace armata alla prima EOF: riferimento per il seguito
    const grace1 = timers.filter((t) => t.ms > 0 && !t.cancelled).pop();
    assert.ok(grace1, 'timer di grace armato alla prima EOF');

    // proof fresco entro grace -> lease nuovo -> reconnected
    const fresh = forgeProof(home, clock, {
      kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st.leaseId, generation: '0',
    });
    const ok = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(ok.msg.type, 'lease');
    ev = s.events();
    const rec = ev.filter((e) => e.event === 'reconnected' && e.cell === 'alpha');
    assert.equal(rec.length, 1, 'una riga di successo');
    assert.equal(rec[0].generation, 0);
    assert.equal(mgr.status('alpha').state, 'live', 'il lease riconnesso e live');
    // Il rebind ha annullato la grace della prima EOF: quel timer e' morto e
    // non va eseguito. Nessun termine durante un reconnect riuscito.
    assert.ok(grace1.cancelled, 'la grace della prima EOF e stata annullata dal rebind');
    assert.equal(s.events().filter((e) => e.event === 'terminal').length, 0, 'nessun terminal col lease live');

    // chiusura del canale RICONNESSO: nuova EOF -> nuova grace per il lease corrente
    ok.sock.destroy();
    await new Promise((r) => setTimeout(r, 30));
    ev = s.events();
    assert.equal(ev.filter((e) => e.event === 'terminal').length, 0, 'ancora nessun terminal');
    const grace2 = timers.filter((t) => t.ms > 0 && !t.cancelled).pop();
    assert.ok(grace2 && grace2 !== grace1, 'nuova grace armata per il lease corrente');
    assert.equal(mgr.status('alpha').state, 'grace', 'il lease corrente e in grace');

    // scadenza della SOLA nuova grace: termine del lease corrente, una volta
    clock.t += grace2.ms + 1;
    grace2.fn();
    ev = s.events();
    const term = ev.filter((e) => e.event === 'terminal' && e.cell === 'alpha');
    assert.equal(term.length, 1, 'una riga di termine');
    assert.equal(term[0].reason, 'grace');
    const endState = mgr.status('alpha');
    assert.equal(endState.state, 'expired', 'il lease terminato e scaduto, non live');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('manager: il sink diagnostico guasto non cambia l\'esito del lease', async () => {
  const { home, clock, mgr } = setup(() => { throw new Error('sink dead'); });
  try {
    await mgr.boot();
    const { client } = await attachWithProof(mgr, 'alpha', clock);
    await untilNotLive(mgr, 'alpha');
    assert.doesNotThrow(() => client.destroy());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mgr.status('alpha').state, 'grace');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cablaggio: dal servizio reale (cfg.log assente) il sink riceve lease-start dal provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leasewire-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const configDir = path.join(root, 'config'); fs.mkdirSync(configDir);
  const filesRoot = path.join(root, 'files'); fs.mkdirSync(filesRoot);
  const cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
  const command = path.join(home, 'bin', 'myclaude');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(command, '#!/bin/sh\necho hi\n'); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'claude', label: 'Claude', rc: true, command, args: ['--x'], promptMode: 'flag', promptFlag: '--append-system-prompt', model: { flag: '--model', value: 'sonnet' } }],
    cells: [{ id: 'alpha', tmuxSession: 'work-build', cwd, engine: 'claude', boot: true, prompt: 'you are a dev agent' }],
  }));
  const s = sink();
  const runtime = createServer({
    home, configDir, filesRoot, port: 0,
    nodesPath: path.join(configDir, 'nodes.json'),
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    fleetDefsPath: defsPath,
    tmuxBin: path.join(root, 'no-tmux'),
    readonlyDefault: true,
    protectSharedTmuxServer: false,
    cellLeaseEnabled: true,
    leaseLog: s.write,
  });
  try {
    const p = await runtime.fleetP;
    assert.ok(p.available, 'provider builtin disponibile (no seam, no disabled)');
    const ev = s.events();
    const start = ev.filter((e) => e.event === 'lease-start');
    assert.equal(start.length, 1, 'il sink del lease e cablato dal servizio fino al manager');
    assert.ok(Number.isSafeInteger(start[0].ts), 'riga redatta con timestamp');
  } finally {
    try { (await runtime.fleetP).close(); } catch (_) {}
    try { runtime.server.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default del servizio: senza leaseLog esplicito il lease-start va sul trasporto predefinito', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leasewire-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const configDir = path.join(root, 'config'); fs.mkdirSync(configDir);
  const filesRoot = path.join(root, 'files'); fs.mkdirSync(filesRoot);
  const cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
  const command = path.join(home, 'bin', 'myclaude');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(command, '#!/bin/sh\necho hi\n'); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'claude', label: 'Claude', rc: true, command, args: ['--x'], promptMode: 'flag', promptFlag: '--append-system-prompt', model: { flag: '--model', value: 'sonnet' } }],
    cells: [{ id: 'alpha', tmuxSession: 'work-build', cwd, engine: 'claude', boot: true, prompt: 'you are a dev agent' }],
  }));
  // Nessun leaseLog esplicito e cfg.log assente: la riga di inizio deve
  // attraversare il trasporto PREDEFINITO del servizio, non restare muta.
  const orig = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return orig(chunk, ...rest);
  };
  let runtime = null;
  try {
    runtime = createServer({
      home, configDir, filesRoot, port: 0,
      nodesPath: path.join(configDir, 'nodes.json'),
      configPath: path.join(configDir, 'config.json'),
      tokenPath: path.join(configDir, 'token'),
      fleetDefsPath: defsPath,
      tmuxBin: path.join(root, 'no-tmux'),
      readonlyDefault: true,
      protectSharedTmuxServer: false,
      cellLeaseEnabled: true,
    });
    const p = await runtime.fleetP;
    assert.ok(p.available, 'provider builtin disponibile');
    const lines = captured.split('\n').filter((l) => l.startsWith('cell-lease: '));
    const start = lines
      .map((l) => JSON.parse(l.slice('cell-lease: '.length)))
      .filter((e) => e.event === 'lease-start');
    assert.equal(start.length, 1, 'il trasporto predefinito emette la riga di inizio redatta');
    assert.ok(Number.isSafeInteger(start[0].ts), 'riga redatta con timestamp');
  } finally {
    process.stdout.write = orig;
    if (runtime) {
      try { (await runtime.fleetP).close(); } catch (_) {}
      try { runtime.server.close(); } catch (_) {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trasporto predefinito: l\'errore asincrono del sink non abbatte il demone', async () => {
  const { Writable } = require('node:stream');
  const out = new Writable({
    write(chunk, enc, cb) { setImmediate(() => cb(new Error('broken pipe'))); },
  });
  assert.equal(out.listenerCount('error'), 0, 'canale vergine: nessun listener prima della protezione');
  // L'avviso viaggia sul descrittore secondario in modo SINCRONO: si osserva
  // intercettando writeSync, senza toccare il canale stderr del runner.
  const fsmod = require('node:fs');
  const wsOrig = fsmod.writeSync;
  const notices = [];
  fsmod.writeSync = (fd, data, ...rest) => {
    if (fd === 2) notices.push(String(data));
    return wsOrig.call(fsmod, fd, data, ...rest);
  };
  let write;
  try {
    write = createDefaultWrite(out);
    assert.ok(out.listenerCount('error') >= 1, 'la protezione dell\'errore asincrono e installata una volta');
    assert.doesNotThrow(() => write('cell-lease: {"event":"lease-start"}\n'));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Il demone resta operativo e il guasto resta OSSERVABILE: una sola riga
    // di avviso, non un silenzio permanente.
    assert.equal(notices.filter((l) => l.includes('default transport failed')).length, 1, 'il guasto del trasporto e segnalato una volta');
    // Il trasporto rotto e sospeso: le righe successive non tentano piu' la
    // scrittura su un canale morto (niente buffer che cresce), senza eccezioni.
    let attempted = 0;
    const origWrite = out.write.bind(out);
    out.write = (...a) => { attempted += 1; return origWrite(...a); };
    assert.doesNotThrow(() => write('cell-lease: {"event":"eof"}\n'));
    assert.equal(attempted, 0, 'il canale rotto non riceve altre righe');
  } finally {
    fsmod.writeSync = wsOrig;
  }
});

test('secondario guasto: l\'avviso e best-effort, la sospensione resta, il demone sopravvive', async () => {
  const { Writable } = require('node:stream');
  const mkBroken = () => new Writable({
    write(chunk, enc, cb) { setImmediate(() => cb(new Error('broken pipe'))); },
  });

  // NEGATIVO sincrono: anche il canale secondario rifiuta (il suo rilascio
  // fallisce). Nessuna eccezione, il primario resta sospeso, zero write.
  const out1 = mkBroken();
  const w1 = createDefaultWrite(out1, { notice: () => { throw new Error('secondary gone'); } });
  let writes1 = 0;
  const ow1 = out1.write.bind(out1);
  out1.write = (...a) => { writes1 += 1; return ow1(...a); };
  assert.doesNotThrow(() => w1('cell-lease: {"event":"lease-start"}\n'));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(out1.__leaseDiagGuard && out1.__leaseDiagGuard.broken, 'primario sospeso anche senza avviso');
  const before1 = writes1;
  assert.doesNotThrow(() => w1('cell-lease: {"event":"eof"}\n'));
  assert.equal(writes1, before1, 'zero write dopo la sospensione');

  // NEGATIVO stesso canale: il primario E il secondario coincidono: l'avviso
  // non va MAI scritto sul canale appena dichiarato guasto.
  const out2 = mkBroken();
  let notices2 = 0;
  const w2 = createDefaultWrite(out2, { secondary: out2, notice: () => { notices2 += 1; } });
  assert.doesNotThrow(() => w2('cell-lease: {"event":"lease-start"}\n'));
  await new Promise((r) => setImmediate(r));
  assert.equal(notices2, 0, 'mai un avviso sul canale guasto stesso');
  assert.ok(out2.__leaseDiagGuard && out2.__leaseDiagGuard.broken, 'sospensione attiva comunque');

  // POSITIVO + ripetuti + wrapper multipli: secondario sano, un solo avviso,
  // un solo listener, nessun nuovo tentativo sul primario da nessun wrapper.
  const out3 = mkBroken();
  let notices3 = 0;
  const wa = createDefaultWrite(out3, { notice: () => { notices3 += 1; } });
  const wb = createDefaultWrite(out3, { notice: () => { notices3 += 1; } });
  let writes3 = 0;
  const ow3 = out3.write.bind(out3);
  out3.write = (...a) => { writes3 += 1; return ow3(...a); };
  assert.doesNotThrow(() => wa('cell-lease: {"event":"lease-start"}\n'));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  out3.emit('error', new Error('again'));
  await new Promise((r) => setImmediate(r));
  assert.equal(out3.listenerCount('error'), 1, 'un solo listener sul canale condiviso');
  assert.equal(notices3, 1, 'al massimo un avviso, errori ripetuti compresi');
  const before3 = writes3;
  wa('cell-lease: {"event":"eof"}\n');
  wb('cell-lease: {"event":"eof"}\n');
  assert.equal(writes3, before3, 'nessun wrapper scrive sul primario sospeso');
});
