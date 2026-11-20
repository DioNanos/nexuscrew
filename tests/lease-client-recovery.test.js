'use strict';
// Lease-client recovery window (bounded episode, tight retries, terminal
// conclusion). Clock e socket sono interamente iniettati: nessun timer reale,
// nessun servizio vero. Lo scenario parte dal client REALE
// (lib/fleet/lease-client.js) con seam setTimeout/clearTimeout/net/now/monoNow.
//
// Modello dell'endpoint finto (nessun nodo o servizio esistente):
//   - connect(): la connessione viene aperta o rifiutata in base alla policy;
//     ogni azione dell'endpoint e' differita al pump della harness, come lo
//     sarebbe un giro di event loop reale;
//   - le risposte (deny / frame lease) escono SOLO dal verificatore finto,
//     che decide guardando l'expiry del proof presentato: la decisione di
//     autenticita' resta lato server, il client non la anticipa.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

const WALL0 = 1_700_000_000_000;
const STABLE_PATH = '/tmp/lease-client-recovery-test.sock';

// ---------------------------------------------------------------- harness --

function makeHarness({ fireLagMs = 0 } = {}) {
  let mono = 0;
  let wall = WALL0;
  const timers = new Map();
  let timerSeq = 0;
  const pending = [];
  const attempts = [];
  const sockets = [];

  const setTimer = (fn, ms) => {
    timerSeq += 1;
    timers.set(timerSeq, { fn, due: mono + ms });
    return { id: timerSeq };
  };
  const clearTimer = (h) => { if (h) timers.delete(h.id); };

  function fireDue() {
    for (;;) {
      let pick = null;
      let pickDue = Infinity;
      for (const [id, t] of timers) {
        // fireLagMs: ritardo di esecuzione uniforme (il runtime puo' eseguire
        // un timer armato dentro la finestra dopo la sua scadenza).
        if (t.due + fireLagMs <= mono && t.due < pickDue) { pickDue = t.due; pick = id; }
      }
      if (pick === null) return;
      const t = timers.get(pick);
      timers.delete(pick);
      t.fn();
    }
  }
  function flush() { while (pending.length) pending.shift()(); }
  function pump() { fireDue(); flush(); fireDue(); flush(); }
  function advance(ms, opts) {
    mono += ms;
    wall += opts && opts.wallDelta !== undefined ? opts.wallDelta : ms;
    pump();
  }
  // Avanza il tempo SENZA eseguire i timer ormai dovuti: il runtime puo'
  // consegnare un frame prima del dispatch dei callback scaduti.
  function stall(ms) { mono += ms; wall += ms; }

  let endpoint = { connect() {}, onClientLine() {} };

  const netImpl = {
    createConnection(p, cb) {
      const sock = new EventEmitter();
      sock.path = p;
      sock.destroyed = false;
      sock.writable = true;
      sock.written = [];
      sock.received = [];
      sock.setEncoding = () => {};
      sock.write = (line) => {
        sock.written.push({ at: mono, line: String(line) });
        endpoint.onClientLine(sock, String(line), mono);
        return true;
      };
      const origEmit = sock.emit.bind(sock);
      sock.emit = (ev, ...args) => {
        if (ev === 'data') sock.received.push(String(args[0]));
        return origEmit(ev, ...args);
      };
      sock.destroy = () => {
        if (sock.destroyed) return;
        sock.destroyed = true;
        sock.emit('close');
      };
      sockets.push(sock);
      attempts.push({ at: mono });
      pending.push(() => endpoint.connect(sock, cb, mono));
      return sock;
    },
  };

  return {
    netImpl,
    monoNow: () => mono,
    wallNow: () => wall,
    setTimer,
    clearTimer,
    advance,
    pump,
    stall,
    attempts,
    sockets,
    liveSockets: () => sockets.filter((s) => !s.destroyed),
    setEndpoint(e) { endpoint = e; },
    jumpWall(ms) { wall += ms; },
  };
}

function makeInitialSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.writable = true;
  s.setEncoding = () => {};
  s.write = () => true;
  s.destroy = () => { if (s.destroyed) return; s.destroyed = true; s.emit('close'); };
  return s;
}

function startClient(h, { proof, seams = {}, info = {} } = {}) {
  const initial = makeInitialSocket();
  const events = { lost: [] };
  const ctl = startLeaseClient(initial, {
    stablePath: STABLE_PATH,
    launchEpoch: 'ab'.repeat(8),
    generation: 0,
    onLost: () => events.lost.push(h.monoNow()),
    ...info,
  }, {
    setTimeout: h.setTimer,
    clearTimeout: h.clearTimer,
    net: h.netImpl,
    now: h.wallNow,
    monoNow: h.monoNow,
    ...seams,
  });
  if (proof) {
    initial.emit('data', `${JSON.stringify({ type: 'lease', leaseId: 'e'.repeat(16), proof })}\n`);
  }
  return { ctl, initial, events };
}

// Endpoint: connect rifiutata fino a upAt (o sempre, se Infinity); le risposte
// alle righe reconnect escono da respond (deny | frame lease | nulla = muto).
function refusalEndpoint({ upAt = Infinity, respond } = {}) {
  return {
    connect(sock, cb, at) {
      if (at < upAt) {
        const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
        sock.emit('error', err);
        sock.destroy();
        return;
      }
      cb();
    },
    onClientLine(sock, line, at) {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || msg.type !== 'reconnect') return;
      if (!respond) return;
      const reply = respond(msg, at);
      if (reply) sock.emit('data', `${JSON.stringify(reply)}\n`);
    },
  };
}

// Verificatore finto: lease solo se il proof presentato non e' scaduto sul
// wall clock del server; altrimenti deny. La scadenza resta del server.
function verifier({ renewForMs = 60_000 } = {}) {
  return (msg, at) => {
    const p = msg.proof;
    if (!p || typeof p !== 'object' || WALL0 + at >= p.expiresAt) return { type: 'deny' };
    return {
      type: 'lease',
      leaseId: 'f'.repeat(16),
      proof: {
        kind: 'lease', cellId: p.cellId, launchEpoch: p.launchEpoch,
        leaseId: 'f'.repeat(16), generation: '0', jti: '9'.repeat(16),
        issuedAt: WALL0 + at, expiresAt: WALL0 + at + renewForMs, proof: '1'.repeat(64),
      },
    };
  };
}

const HELD_PROOF = {
  kind: 'lease', cellId: 'cell-one', launchEpoch: 'ab'.repeat(8), leaseId: 'b'.repeat(16),
  generation: '0', jti: 'c'.repeat(16), issuedAt: WALL0, expiresAt: WALL0 + 49_000,
  proof: 'd'.repeat(64),
};

function advanceUntil(h, cond, budgetMs, stepMs = 500) {
  for (let t = 0; t <= budgetMs; t += stepMs) {
    if (cond()) return h.monoNow();
    h.advance(stepMs);
  }
  return cond() ? h.monoNow() : null;
}

function writesOfType(sock, type) {
  return sock.written.filter((w) => { try { return JSON.parse(w.line).type === type; } catch (_) { return false; } });
}

function receivedOfType(sock, type) {
  return sock.received.filter((l) => { try { return JSON.parse(l).type === type; } catch (_) { return false; } });
}

// ------------------------------------------------------------------ tests --

test('recovery inside the held proof window: refusal at +40, retry within 1s, lease frame resumes, no onLost', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: verifier() }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close'); // EOF del canale live: apre l'episodio di recupero
  h.pump();

  const recoveredAt = advanceUntil(h, () => ctl._isConnected() && h.liveSockets().length === 1
    && writesOfType(h.liveSockets()[0], 'reconnect').length > 0, 120_000);

  assert.notEqual(recoveredAt, null, 'il client recupera entro la finestra del proof');
  assert.ok(recoveredAt <= 46_000, `ripresa subito dopo il ritorno dell'endpoint (a ${recoveredAt}ms)`);
  assert.equal(events.lost.length, 0, 'nessun onLost: la lease non e\' stata persa');
  assert.ok(recoveredAt < 49_000, 'ripresa prima della scadenza del proof detenuto');

  // Retry ravvicinati: dopo ogni rifiuto il tentativo seguente entro 1000ms
  // (c'e' un rifiuto poco dopo i 40s: il vecchio intervallo da 20s lo saltava).
  const times = h.attempts.map((a) => a.at);
  assert.ok(times.length > 40, `tentativi ravvicinati nella finestra (avuti ${times.length})`);
  const inWindow = times.filter((t) => t >= 1_000 && t < 45_000);
  for (let i = 1; i < inWindow.length; i += 1) {
    assert.ok(inWindow[i] - inWindow[i - 1] <= 1_000, `gap retry ${inWindow[i] - inWindow[i - 1]}ms <= 1000ms`);
  }

  // Ripresa effettiva: heartbeat di nuovo attivo e proof detenuto aggiornato
  // PER VALORE (jti/expiry del proof realmente restituito dall'endpoint).
  h.advance(20_000);
  const live = h.liveSockets();
  assert.equal(live.length, 1, 'una sola connessione viva dopo la ripresa');
  assert.ok(writesOfType(live[0], 'refresh').length >= 1, 'heartbeat ripreso dopo il frame lease');
  assert.equal(ctl._heldProof().jti, '9'.repeat(16), 'heldProof aggiornato col proof del nuovo frame');
  assert.equal(ctl._heldProof().expiresAt, WALL0 + recoveredAt + 60_000, 'expiry del proof aggiornato');
  ctl.stop();
});

test('endpoint back after the held proof expiry: authentic deny, terminal at the deadline, onLost once', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 55_000, respond: verifier() })); // proof scade a +49
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);

  assert.notEqual(lostAt, null, 'onLost arriva');
  assert.equal(events.lost.length, 1, 'onLost una sola volta');
  assert.equal(events.lost[0], 60_000, 'terminale alla deadline dell\'episodio (EOF+60s)');
  const after = h.attempts.filter((a) => a.at >= 60_000);
  assert.equal(after.length, 0, `nessuna connessione a o oltre la deadline (avute ${after.length})`);
  // Rifiuto autentico: il proof scaduto e' stato presentato dentro la finestra
  // e negato dal verificatore (la decisione resta del server).
  const denied = h.sockets.filter((s) => receivedOfType(s, 'deny').length > 0);
  assert.ok(denied.length >= 1, 'il proof scaduto e\' stato presentato e negato dal server');
  assert.equal(h.liveSockets().length, 0, 'nessun socket pendente dopo il terminale');
  ctl.stop();
});

test('mute server: terminal fires at the deadline, not at the last attempt timeout', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: null })); // connette, poi silenzio
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 100_000);

  assert.notEqual(lostAt, null, 'onLost arriva');
  assert.equal(events.lost[0], 60_000, `terminale a E=60s anche con server muto (a ${events.lost[0]}ms)`);
  assert.equal(h.attempts.filter((a) => a.at >= 60_000).length, 0, 'nessuna connessione a o oltre E');
  h.advance(5_000);
  assert.equal(h.liveSockets().length, 0, 'il socket del tentativo muto e\' stato chiuso al terminale');
  ctl.stop();
});

test('a retry timer armed before E but due at/after E opens no connection', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: Infinity, respond: null })); // sempre rifiutato
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  // Con retry ravvicinati c'e' un timer dovuto esattamente a E: non deve aprire.
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);

  assert.notEqual(lostAt, null, 'onLost arriva');
  assert.equal(events.lost[0], 60_000, 'terminale a E');
  const after = h.attempts.filter((a) => a.at >= 60_000);
  assert.equal(after.length, 0, `il timer eseguito a/oltre E non apre connessioni (avute ${after.length})`);
  const before = h.attempts.length;
  h.advance(10_000);
  assert.equal(h.attempts.length, before, 'nessun tentativo dopo il terminale');
  ctl.stop();
});

test('per-episode attempt cap: at most 64 attempts, then terminal', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: Infinity, respond: null }));
  const { ctl, initial, events } = startClient(h, {
    proof: HELD_PROOF,
    seams: { retryDelayMs: 10 }, // seam di test: esercita il cap prima della grace
  });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 5_000, 10);

  assert.notEqual(lostAt, null, 'il cap chiude l\'episodio anche senza attendere la grace');
  assert.equal(h.attempts.length, 64, `esattamente 64 tentativi per episodio (avuti ${h.attempts.length})`);
  assert.equal(events.lost.length, 1, 'onLost una sola volta');
  const before = h.attempts.length;
  h.advance(5_000);
  assert.equal(h.attempts.length, before, 'nessun tentativo oltre il cap');
  ctl.stop();
});

test('mixed refusals, denials and silence: one live socket at a time, tight retries, clean terminal', () => {
  const h = makeHarness();
  let maxLive = 0;
  // rifiutato fino a 10s; deny fra 10s e 20s; connessione muta da 20s.
  h.setEndpoint(refusalEndpoint({
    upAt: 10_000,
    respond: (msg, at) => (at < 20_000 ? { type: 'deny' } : null),
  }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => {
    maxLive = Math.max(maxLive, h.liveSockets().length);
    return events.lost.length > 0;
  }, 90_000);

  assert.ok(maxLive <= 1, `al massimo un socket attivo alla volta (picco ${maxLive})`);
  assert.notEqual(lostAt, null, 'onLost arriva');
  assert.equal(events.lost[0], 60_000, 'terminale alla deadline');
  assert.ok(h.attempts.length >= 20, `retry ravvicinati attraverso fasi miste (avuti ${h.attempts.length})`);
  assert.equal(h.liveSockets().length, 0, 'nessun socket pendente dopo il terminale');
  ctl.stop();
});

test('a late lease frame after the terminal is ignored (no revival)', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: null })); // muto
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);
  assert.notEqual(lostAt, null, 'terminale a E');
  assert.equal(events.lost[0], 60_000, 'il terminale arriva alla deadline, indipendente dal peer');

  // Il vecchio tentativo risponde SOLO DOPO il terminale: frame ignorato.
  const stale = h.sockets[h.sockets.length - 1];
  const late = { type: 'lease', leaseId: 'f'.repeat(16), proof: { ...HELD_PROOF, expiresAt: WALL0 + 120_000 } };
  stale.emit('data', `${JSON.stringify(late)}\n`);
  h.advance(25_000);

  assert.equal(ctl._isConnected(), false, 'nessuna ripresa dopo il terminale');
  assert.equal(writesOfType(stale, 'refresh').length, 0, 'nessun heartbeat su un frame tardivo');
  assert.deepEqual(ctl._heldProof(), HELD_PROOF, 'un frame tardivo non aggiorna il proof detenuto');
  assert.equal(events.lost.length, 1, 'onLost resta uno');
  ctl.stop();
});

test('a late lease frame after stop() is ignored (no revival)', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 0, respond: null })); // connette muto subito
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  advanceUntil(h, () => h.liveSockets().length === 1, 5_000, 10);
  const pendingSock = h.liveSockets()[0];
  assert.ok(pendingSock, 'tentativo in corso con socket aperto');

  ctl.stop();
  const late = { type: 'lease', leaseId: 'f'.repeat(16), proof: { ...HELD_PROOF, expiresAt: WALL0 + 120_000 } };
  pendingSock.emit('data', `${JSON.stringify(late)}\n`);
  h.advance(25_000);

  assert.equal(ctl._isConnected(), false, 'stop resta definitivo');
  assert.equal(writesOfType(pendingSock, 'refresh').length, 0, 'nessun heartbeat dopo stop');
  assert.deepEqual(ctl._heldProof(), HELD_PROOF, 'un frame dopo stop non aggiorna il proof detenuto');
  assert.equal(events.lost.length, 0, 'onLost non arriva dal canale di stop');
  assert.equal(h.liveSockets().length, 0, 'il socket del tentativo viene chiuso da stop');
});

test('a wall clock jump does not extend the local episode deadline', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: Infinity, respond: null }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  h.advance(30_000);
  h.jumpWall(-45_000); // il wall clock torna indietro: la deadline non segue
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);

  assert.notEqual(lostAt, null, 'l\'episodio termina comunque');
  assert.equal(events.lost[0], 60_000, `deadline locale invariata dal salto (onLost a ${events.lost[0]}ms)`);
  assert.equal(h.attempts.filter((a) => a.at >= 60_000).length, 0, 'nessuna connessione oltre E');
  ctl.stop();
});

test('a recovered episode is followed by a fresh episode on the next EOF', () => {
  const h = makeHarness();
  // endpoint: vivo subito, giu' fra 5s e 15s, di nuovo vivo da 15s.
  h.setEndpoint({
    connect(sock, cb, at) {
      if (at >= 5_000 && at < 15_000) {
        const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
        sock.emit('error', err);
        sock.destroy();
        return;
      }
      cb();
    },
    onClientLine(sock, line, at) {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || msg.type !== 'reconnect') return;
      const reply = verifier()(msg, at);
      if (reply) sock.emit('data', `${JSON.stringify(reply)}\n`);
    },
  });
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  // Primo episodio: recupero immediato (endpoint vivo).
  initial.emit('close');
  const firstAt = advanceUntil(h, () => ctl._isConnected(), 5_000, 10);
  assert.notEqual(firstAt, null, 'primo episodio recuperato');
  const first = h.liveSockets()[0];

  // Secondo episodio: EOF sulla connessione ristabilita mentre l'endpoint e' giu'.
  h.advance(5_000);
  const before = h.attempts.length;
  first.emit('close');
  const secondAt = advanceUntil(h, () => ctl._isConnected(), 70_000);

  assert.notEqual(secondAt, null, 'secondo episodio recuperato');
  assert.ok(secondAt <= 20_000, `il nuovo episodio riprova ravvicinato e recupera (a ${secondAt}ms)`);
  const secondTimes = h.attempts.slice(before).map((a) => a.at);
  assert.ok(secondTimes.length > 8, `il nuovo episodio riprova ravvicinato (avuti ${secondTimes.length})`);
  for (let i = 1; i < secondTimes.length; i += 1) {
    assert.ok(secondTimes[i] - secondTimes[i - 1] <= 1_000, 'gap retry del nuovo episodio <= 1000ms');
  }
  assert.equal(events.lost.length, 0, 'nessun onLost nei due recuperi');
  ctl.stop();
});

test('a retry timer armed inside the grace but fired past E opens no connection', () => {
  // Il runtime puo' eseguire in ritardo un timer armato dentro la finestra:
  // l'esecuzione a/oltre E non deve aprire connessioni (ricontrollo nel
  // callback, alla partenza del tentativo e all'apertura del socket).
  const h = makeHarness({ fireLagMs: 7_000 });
  h.setEndpoint(refusalEndpoint({ upAt: Infinity, respond: null }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);

  assert.notEqual(lostAt, null, 'onLost arriva nonostante il ritardo di esecuzione');
  assert.equal(events.lost.length, 1, 'onLost una sola volta');
  assert.ok(h.attempts.length >= 3, 'l\'episodio ha provato dentro la finestra');
  const after = h.attempts.filter((a) => a.at >= 60_000);
  assert.equal(after.length, 0, `timer eseguiti oltre E non aprono connessioni (avute ${after.length})`);
  ctl.stop();
});

// ---- frame lease consegnato quando E e' gia' passato, timer dovuti non
// ancora eseguiti: il termine si conclude comunque e il frame e' ignorato ----

test('a lease frame processed at E (terminal timer due, not dispatched) concludes the episode', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: null })); // muto da 45s
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const opened = advanceUntil(h, () => h.liveSockets().length === 1
    && writesOfType(h.liveSockets()[0], 'reconnect').length > 0, 55_000);
  assert.notEqual(opened, null, 'tentativo muto aperto dentro la finestra');
  const sock = h.liveSockets()[0];

  // Il monotono arriva a E senza eseguire i timer ormai dovuti.
  h.stall(60_000 - h.monoNow());
  const late = {
    type: 'lease', leaseId: 'f'.repeat(16),
    proof: { ...HELD_PROOF, jti: '9'.repeat(16), expiresAt: WALL0 + 120_000 },
  };
  sock.emit('data', `${JSON.stringify(late)}\n`);
  h.pump(); // dispatch dei timer dovuti
  h.advance(25_000);

  assert.equal(events.lost.length, 1, 'onLost una volta anche con frame a E');
  assert.deepEqual(ctl._heldProof(), HELD_PROOF, 'nessun aggiornamento del proof a E');
  assert.equal(ctl._isConnected(), false, 'nessuna ripresa a E');
  assert.equal(writesOfType(sock, 'refresh').length, 0, 'nessun heartbeat dopo il frame a E');
  assert.ok(sock.destroyed, 'socket del tentativo chiuso');
  ctl.stop();
});

test('a lease frame processed at E+1 (terminal timer due, not dispatched) concludes the episode', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: null }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const opened = advanceUntil(h, () => h.liveSockets().length === 1
    && writesOfType(h.liveSockets()[0], 'reconnect').length > 0, 55_000);
  assert.notEqual(opened, null, 'tentativo muto aperto dentro la finestra');
  const sock = h.liveSockets()[0];

  h.stall(60_001 - h.monoNow());
  const late = {
    type: 'lease', leaseId: 'f'.repeat(16),
    proof: { ...HELD_PROOF, jti: '9'.repeat(16), expiresAt: WALL0 + 120_000 },
  };
  sock.emit('data', `${JSON.stringify(late)}\n`);
  h.pump();
  h.advance(25_000);

  assert.equal(events.lost.length, 1, 'onLost una volta anche con frame a E+1');
  assert.deepEqual(ctl._heldProof(), HELD_PROOF, 'nessun aggiornamento del proof a E+1');
  assert.equal(ctl._isConnected(), false, 'nessuna ripresa a E+1');
  assert.equal(writesOfType(sock, 'refresh').length, 0, 'nessun heartbeat dopo il frame a E+1');
  assert.ok(sock.destroyed, 'socket del tentativo chiuso');
  ctl.stop();
});

test('a lease frame processed just before E (E-1) still succeeds', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: 45_000, respond: null }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  const opened = advanceUntil(h, () => h.liveSockets().length === 1
    && writesOfType(h.liveSockets()[0], 'reconnect').length > 0, 55_000);
  assert.notEqual(opened, null, 'tentativo muto aperto dentro la finestra');
  const sock = h.liveSockets()[0];

  h.stall(59_999 - h.monoNow());
  const inTime = {
    type: 'lease', leaseId: 'f'.repeat(16),
    proof: { ...HELD_PROOF, jti: '9'.repeat(16), expiresAt: WALL0 + 120_000 },
  };
  sock.emit('data', `${JSON.stringify(inTime)}\n`);
  h.pump();

  assert.equal(events.lost.length, 0, 'nessun onLost: il frame e\' entro E');
  assert.equal(ctl._heldProof().jti, '9'.repeat(16), 'proof aggiornato per valore');
  assert.equal(ctl._isConnected(), true, 'ripresa ammessa a E-1');
  h.advance(20_000);
  assert.ok(writesOfType(sock, 'refresh').length >= 1, 'heartbeat ripreso dal frame a E-1');
  ctl.stop();
});

test('a forward wall clock jump does not shorten the local episode deadline', () => {
  const h = makeHarness();
  h.setEndpoint(refusalEndpoint({ upAt: Infinity, respond: null }));
  const { ctl, initial, events } = startClient(h, { proof: HELD_PROOF });

  initial.emit('close');
  h.advance(30_000);
  h.jumpWall(45_000); // il wall clock salta avanti: la finestra locale non cambia
  const lostAt = advanceUntil(h, () => events.lost.length > 0, 90_000);

  assert.notEqual(lostAt, null, 'l\'episodio termina');
  assert.equal(events.lost[0], 60_000, `nessun termine anticipato dal salto avanti (onLost a ${events.lost[0]}ms)`);
  assert.equal(h.attempts.filter((a) => a.at >= 60_000).length, 0, 'nessuna connessione oltre E');
  ctl.stop();
});
