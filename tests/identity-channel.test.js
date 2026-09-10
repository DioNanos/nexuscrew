'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createIdentityChannel, validIdentityRequest } = require('../lib/fleet/cell-exec.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient, identityErrorCode, validDaemonChallenge } = require('../lib/fleet/lease-client.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

const CELL = 'CellA';

function challenge(overrides = {}) {
  const now = Date.now();
  return {
    version: 1,
    audience: 'daemon/connection-a',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    nonce: 'a'.repeat(64),
    issuedAt: now,
    expiresAt: now + 15_000,
    ...overrides,
  };
}

function identityRpc(id, value = challenge({ nonce: 'b'.repeat(64) })) {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'nexuscrew/identity/challengeProof',
    params: { challenge: value },
  })}\n`;
}

function lineReader(stream) {
  const lines = [];
  let waiters = [];
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else lines.push(value);
    }
  });
  return {
    next() {
      const cached = lines.shift();
      if (cached) return Promise.resolve(cached);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

test('identity request schema is closed', () => {
  assert.equal(validIdentityRequest({
    jsonrpc: '2.0', id: 1, method: 'nexuscrew/identity/challengeProof', params: {},
  }), true);
  assert.equal(validIdentityRequest({
    jsonrpc: '2.0', id: 1, method: 'nexuscrew/identity/challengeProof', params: {}, extra: true,
  }), false);
  assert.equal(validIdentityRequest({
    jsonrpc: '1.0', id: 1, method: 'nexuscrew/identity/challengeProof', params: {},
  }), false);
});

test('identity channel returns a proof on fd responses', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  const proof = { kind: 'identity-proof', cellId: CELL, proof: 'f'.repeat(64) };
  let observed = null;
  const expected = challenge({ nonce: 'b'.repeat(64) });
  const channel = createIdentityChannel({
    request, response, generation: 3,
    relay: async (_requestId, value) => { observed = value; return { ok: true, proof }; },
  });
  request.write(identityRpc(7, expected));
  const out = await reader.next();
  assert.deepEqual(observed, expected);
  assert.deepEqual(out, { jsonrpc: '2.0', id: 7, result: { proof } });
  assert.equal(channel.pendingCount(), 0);
  channel.close();
});

test('identity channel rejects malformed requests without relaying them', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  let relayed = false;
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: async () => { relayed = true; return { ok: true, proof: {} }; },
  });
  const badChallenge = challenge({ nonce: 'not-hex' });
  request.write(identityRpc(2, badChallenge));
  const out = await reader.next();
  assert.equal(relayed, false);
  assert.equal(out.error.data.code, 'IDENTITY_UNVERIFIED');
  assert.equal(channel.isClosed(), false);
  channel.close();
});

test('identity channel permits only one pending request', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  let resolveRelay;
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: () => new Promise((resolve) => { resolveRelay = resolve; }),
  });
  request.write(identityRpc(1, challenge({ nonce: 'c'.repeat(64) })));
  await new Promise((resolve) => setImmediate(resolve));
  request.write(identityRpc(2, challenge({ nonce: 'd'.repeat(64) })));
  const busy = await reader.next();
  assert.equal(busy.id, 2);
  assert.equal(busy.error.data.code, 'IDENTITY_UNVERIFIED');
  assert.equal(busy.error.message, 'busy');
  resolveRelay({ ok: true, proof: { kind: 'identity-proof' } });
  const first = await reader.next();
  assert.equal(first.id, 1);
  assert.equal(first.result.proof.kind, 'identity-proof');
  channel.close();
});

test('identity channel maps relay reasons to stable codes', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: async () => ({ ok: false, reason: 'replay' }),
  });
  request.write(identityRpc(9));
  const out = await reader.next();
  assert.equal(out.error.data.code, 'REPLAY');
  channel.close();
});

test('revocation invalidates the pending request and closes fd responses', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  const ended = new Promise((resolve) => response.once('end', resolve));
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: () => new Promise(() => {}),
    cancel: () => {},
  });
  request.write(identityRpc(4));
  await new Promise((resolve) => setImmediate(resolve));
  channel.close('REVOKED', 'generation changed');
  const out = await reader.next();
  await ended;
  assert.equal(out.id, 4);
  assert.equal(out.error.data.code, 'REVOKED');
  assert.equal(channel.isClosed(), true);
});

test('identity channel times out an unavailable hub', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const reader = lineReader(response);
  const timers = [];
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: () => new Promise(() => {}),
    cancel: () => {},
    setTimeout: (fn) => { timers.push(fn); return { unref: () => {} }; },
    clearTimeout: () => {},
  });
  const ended = new Promise((resolve) => response.once('end', resolve));
  request.write(identityRpc(5));
  assert.equal(timers.length, 1);
  timers[0]();
  const out = await reader.next();
  assert.equal(out.error.data.code, 'AUTHORITY_UNAVAILABLE');
  // C7-bis: il canale e' terminato su timeout — fd4 EOF dopo la risposta.
  assert.equal(channel.isClosed(), true);
  await ended;
});

test('identity channel closes on a frame over 8 KiB', async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  let relayed = false;
  const channel = createIdentityChannel({
    request, response, generation: 0,
    relay: async () => { relayed = true; return { ok: true, proof: {} }; },
  });
  response.resume();
  const ended = new Promise((resolve) => response.once('end', resolve));
  request.write(`${'x'.repeat(9 * 1024)}\n`);
  await ended;
  assert.equal(relayed, false);
  assert.equal(channel.isClosed(), true);
});

function authorityFixture(home, subject) {
  return createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => Object.entries(subject)
      .every(([key, value]) => candidate[key] === value),
  });
}

async function leaseFixture(t, { withAuthority = true, authorityOptions = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-channel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let subject = null;
  const authority = withAuthority ? createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => !!subject
      && Object.entries(subject).every(([key, value]) => candidate[key] === value),
    ...(authorityOptions || {}),
  }) : null;
  const manager = createLeaseManager({
    home,
    log: () => {},
    identityAuthority: authority,
  });
  t.after(() => manager.close());
  const lease = await manager.track(CELL);
  subject = {
    ownerInstanceId: 'owner-a',
    cellId: CELL,
    incarnationId: 'incarnation-a',
    launchEpoch: lease.launchEpoch,
  };
  assert.equal(manager.setLaunchSubject(CELL, subject), true);

  const socketPath = path.join(home, 'pair.sock');
  const server = net.createServer();
  const connected = new Promise((resolve) => server.once('connection', resolve));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = net.createConnection(socketPath);
  const [serverSide] = await Promise.all([connected, new Promise((resolve) => client.once('connect', resolve))]);
  assert.equal(manager.attachInitial(CELL, serverSide, { generation: 4 }), true);
  t.after(() => {
    try { client.destroy(); } catch (_) {}
    try { server.close(); } catch (_) {}
  });
  return { manager, authority, subject, client, reader: lineReader(client) };
}


function fixReadLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      stream.off('data', onData);
      resolve(JSON.parse(buf.slice(0, nl)));
    };
    stream.on('data', onData);
    stream.once('close', () => reject(new Error('eof before relay reply')));
    setTimeout(() => reject(new Error('timeout waiting relay reply')), 5000).unref();
  });
}

function relayFrame(value, generation = 4) {
  const requestId = typeof value === 'string' ? value : `req-${Math.random().toString(16).slice(2)}`;
  return {
    requestId,
    raw: `${JSON.stringify({
      type: 'challengeProof',
      requestId,
      generation,
      challenge: value && typeof value === 'object' ? value : challenge({ nonce: value }),
    })}\n`,
  };
}

test('lease relay issues from the authenticated launch subject', async (t) => {
  const fix = await leaseFixture(t);
  const { requestId, raw } = relayFrame(challenge({ nonce: 'e'.repeat(64) }));
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.type, 'challengeProofResult');
  assert.equal(out.requestId, requestId);
  assert.equal(out.ok, true);
  assert.equal(out.proof.cellId, CELL);
  assert.equal(out.proof.incarnationId, 'incarnation-a');
  assert.equal(out.proof.ownerInstanceId, 'owner-a');
});

test('lease relay rejects a duplicate challenge as replay', async (t) => {
  const fix = await leaseFixture(t);
  const value = challenge({ nonce: '1'.repeat(64) });
  const first = relayFrame(value);
  const second = relayFrame(value);
  second.requestId = first.requestId;
  second.raw = second.raw.replace(/"req-[^"]+"/, JSON.stringify(first.requestId));
  fix.client.write(first.raw);
  fix.client.write(second.raw);
  const ok = await fix.reader.next();
  const replay = await fix.reader.next();
  assert.equal(ok.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replay');
});

test('lease relay rejects an expired challenge', async (t) => {
  const fix = await leaseFixture(t);
  const past = challenge({ issuedAt: 1, expiresAt: 2 });
  const { raw } = relayFrame(past);
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'expired');
});

test('lease relay rejects a generation mismatch as revoked', async (t) => {
  const fix = await leaseFixture(t);
  const { raw } = relayFrame(challenge({ nonce: '2'.repeat(64) }), 5);
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'revoked');
});

test('lease relay reports a missing authority as unavailable', async (t) => {
  const fix = await leaseFixture(t, { withAuthority: false });
  const { raw } = relayFrame(challenge({ nonce: '3'.repeat(64) }));
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'authority-unavailable');
});

test('lease relay preserves refresh heartbeat behavior', async (t) => {
  const fix = await leaseFixture(t);
  fix.client.write('{"type":"refresh"}\n');
  const ack = await fix.reader.next();
  assert.equal(ack.type, 'ack');
  const { raw } = relayFrame(challenge({ nonce: '4'.repeat(64) }));
  fix.client.write(raw);
  const proof = await fix.reader.next();
  assert.equal(proof.ok, true);
  fix.client.write('{"type":"refresh"}\n');
  const secondAck = await fix.reader.next();
  assert.equal(secondAck.type, 'ack');
});

test('lease relay closes an oversized frame', async (t) => {
  const fix = await leaseFixture(t);
  const ended = new Promise((resolve) => fix.client.once('close', resolve));
  fix.client.write(`${'y'.repeat(9 * 1024)}\n`);
  await ended;
  assert.equal(fix.manager.status(CELL).state, 'grace');
});

test('authority registration and connection proof share incarnationId', async (t) => {
  const fix = await leaseFixture(t);
  const child = fix.manager.childRegister(CELL, { authority: true });
  assert.equal(child.status, 'registered');
  const { raw } = relayFrame(challenge({ nonce: '5'.repeat(64) }));
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(child.incarnationId, 'incarnation-a');
  assert.equal(out.proof.incarnationId, child.incarnationId);
});


// ---- Completamento canale identita': casi mancanti dal referto parziale ----

test('daemon challenge schema rejects coercible types (R4)', () => {
  const base = challenge({ nonce: 'a'.repeat(64) });
  assert.equal(validDaemonChallenge({ ...base, issuedAt: String(base.issuedAt) }), false, 'issuedAt stringa numerica rifiutata');
  assert.equal(validDaemonChallenge({ ...base, expiresAt: String(base.expiresAt) }), false, 'expiresAt stringa numerica rifiutata');
  assert.equal(validDaemonChallenge({ ...base, nonce: ['a'.repeat(64)] }), false, 'nonce array rifiutato');
  assert.equal(validDaemonChallenge({ ...base, nonce: 0x11 }), false, 'nonce numerico rifiutato');
  assert.equal(validDaemonChallenge({ ...base, issuedAt: base.issuedAt, expiresAt: base.expiresAt }), true, 'tipi giusti accettati');
});


// (a) Challenge BEN FORMATA ma non registrabile (store challenge saturo):
// rifiuto IDENTITY_UNVERIFIED dal relay/authority, distinto dalla challenge
// malformata (quella e' respinta dallo schema PRIMA del relay, come provato
// dal test 'rejects malformed requests without relaying them').
test('lease relay rejects a well-formed challenge it cannot register as identity-unverified', async (t) => {
  const fix = await leaseFixture(t, { authorityOptions: { maxChallenges: 1 } });
  const first = relayFrame(challenge({ nonce: '6'.repeat(64) }));
  fix.client.write(first.raw);
  const ok = await fix.reader.next();
  assert.equal(ok.ok, true);
  const second = relayFrame(challenge({ nonce: 'b'.repeat(64) }));
  fix.client.write(second.raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, false);
  // non e' il percorso schema (quelle non arrivano al relay): la challenge
  // raggiunge l'authority e NON riesce a registrarsi -> identity-unverified.
  assert.equal(out.reason, 'identity-unverified');
});

// (b) Revoca/EOF della lease MENTRE la richiesta e' in volo: il relay e' una
// chiamata reale a startLeaseClient; l'authority-wrapper distrugge il socket
// lease lato server PRIMA che la risposta parta. Il client vede EOF ->
// identityDown -> pendenza respinta 'lease-down' -> mappa C10 REVOKED
// (cell-exec chiude fd 4 con REVOKED via onIdentityDown, EOF per la TUI).
test('lease revocation while a challengeProof is in flight rejects as revoked and closes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-channel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let subject = null;
  const authority = createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => !!subject
      && Object.entries(subject).every(([key, value]) => candidate[key] === value),
  });
  let serverSide = null;
  // Seam di TEST via dependency injection: l'authority e' gia' un parametro
  // del lease manager (nessuna modifica a lib/). La "revoca in volo" e' la
  // morte del socket lease fra emissione e risposta.
  const wrapper = {
    issueConnectionProof: (args) => {
      const out = authority.issueConnectionProof(args);
      if (serverSide) { try { serverSide.destroy(); } catch (_) {} }
      return out;
    },
  };
  const manager = createLeaseManager({ home, log: () => {}, identityAuthority: wrapper });
  t.after(() => manager.close());
  const lease = await manager.track(CELL);
  subject = {
    ownerInstanceId: 'owner-a',
    cellId: CELL,
    incarnationId: 'incarnation-a',
    launchEpoch: lease.launchEpoch,
  };
  assert.equal(manager.setLaunchSubject(CELL, subject), true);
  const socketPath = path.join(home, 'pair.sock');
  const server = net.createServer();
  const connected = new Promise((resolve) => server.once('connection', resolve));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = net.createConnection(socketPath);
  const [accepted] = await Promise.all([connected, new Promise((resolve) => client.once('connect', resolve))]);
  serverSide = accepted;
  assert.equal(manager.attachInitial(CELL, accepted, { generation: 4 }), true);
  let identityDownSeen = 0;
  const leaseCtl = startLeaseClient(client, {
    stablePath: lease.stablePath,
    launchEpoch: lease.launchEpoch,
    generation: 4,
    onIdentityDown: () => { identityDownSeen += 1; },
  });
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  const inflight = leaseCtl.challengeProof({
    requestId: 'race-in-flight',
    generation: 4,
    challenge: challenge({ nonce: '7'.repeat(64) }),
  });
  await assert.rejects(inflight, (error) => error.code === 'lease-down');
  // La mappa C10 dei motivi relay: 'lease-down' e' REVOKED (identityErrorCode),
  // e onIdentityDown e' il segnale con cui cell-exec chiude fd 4 (EOF per la TUI).
  assert.equal(identityErrorCode('lease-down'), 'REVOKED');
  assert.equal(identityDownSeen, 1);
  try { client.destroy(); } catch (_) {}
  try { server.close(); } catch (_) {}
});

// (d) Reconnect oltre EOF (heartbeat/refresh riprendono) con denial della
// challenge INVARIATO: la stessa challenge gia' usata resta REPLAY anche sul
// canale riconnesso; una challenge fresca invece passa.
test('reconnect restores the lease and keeps challenge denial invariant', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-channel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let subject = null;
  const authority = createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => !!subject
      && Object.entries(subject).every(([key, value]) => candidate[key] === value),
  });
  let serverSide = null;
  const manager = createLeaseManager({ home, log: () => {}, identityAuthority: authority });
  t.after(() => manager.close());
  const lease = await manager.track(CELL);
  subject = {
    ownerInstanceId: 'owner-a',
    cellId: CELL,
    incarnationId: 'incarnation-a',
    launchEpoch: lease.launchEpoch,
  };
  assert.equal(manager.setLaunchSubject(CELL, subject), true);
  const socketPath = path.join(home, 'pair.sock');
  const server = net.createServer();
  const connected = new Promise((resolve) => server.once('connection', resolve));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = net.createConnection(socketPath);
  const [accepted] = await Promise.all([connected, new Promise((resolve) => client.once('connect', resolve))]);
  serverSide = accepted;
  // Ordine di produzione (R3.1.1): attach PRIMA, poi bind del lease-client che
  // invia il primo refresh immediato -> ACK col proof detenuto. La finestra
  // di settle lascia completare quel round-trip PRIMA dell'EOF: senza di essa
  // il reconnect partirebbe senza proof (fail-closed corretto, ma non e' il
  // caso che questo test vuole).
  assert.equal(manager.attachInitial(CELL, accepted, { generation: 4 }), true);
  const leaseCtl = startLeaseClient(client, {
    // Endpoint stabile REALE del manager (aperto da track): i frame
    // 'reconnect' li gestisce il server lease, come in produzione.
    stablePath: lease.stablePath,
    launchEpoch: lease.launchEpoch,
    generation: 4,
  });
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  const first = await leaseCtl.challengeProof({
    requestId: 'pre-eof', generation: 4, challenge: challenge({ nonce: '8'.repeat(64) }),
  });
  assert.equal(first.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // EOF: muore il socket lease; il client entra in grace e riconnette col
  // proof detenuto (percorso R3.3.2 reale, non simulato).
  serverSide.destroy();
  const deadline = Date.now() + 4000;
  while ((manager.status(CELL).state !== 'live' || !leaseCtl._isConnected()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(manager.status(CELL).state, 'live', 'reconnect oltre EOF riporta la cella live');
  assert.equal(leaseCtl._isConnected(), true, 'client ribandato sul socket riconnesso');
  // Canale riconnesso: challenge fresca -> ok. Il lato client puo' ribindare
  // un istante dopo il server (fail-closed senza grace autorizzativa): una
  // richiesta in quell'intervallo e' 'lease-down' e la TUI la ripete, quindi
  // il test ripete con deadline, come farebbe il consumer reale.
  let second = null;
  const retryDeadline = Date.now() + 4000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    // Ogni tentativo porta una challenge FRESCA: la challenge e' monouso
    // end-to-end (se l'authority l'ha evasa ma la risposta si e' persa, il
    // riuso dello stesso nonce e' REPLAY per progetto — anti-replay C3/C4).
    const fresh = challenge({ nonce: ('d'.repeat(63) + String(attempt % 10)) });
    // 'lease-down' durante la finestra di riconnessione arriva sia come
    // RIFIUTO sia come risoluzione {ok:false}: in entrambi i casi il consumer
    // reale ripete finche' il client non ha ribandato il socket (fail-closed,
    // nessuna grace autorizzativa). Entrambi i percorsi vanno ritentati.
    try {
      second = await leaseCtl.challengeProof({
        requestId: `post-reconnect-${attempt}`, generation: 4, challenge: fresh,
      });
    } catch (error) {
      if (error.code !== 'lease-down' || Date.now() >= retryDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (!(second.ok === false && second.reason === 'lease-down')) break;
    if (Date.now() >= retryDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(second.ok, true, `relay post-reconnect ok (ultima risposta: ${JSON.stringify(second)})`);
  // Denial invariato: la challenge GIÀ consumata prima dell'EOF resta replay.
  await assert.rejects(
    leaseCtl.challengeProof({ requestId: 'replay-post', generation: 4, challenge: challenge({ nonce: '8'.repeat(64) }) }),
    (error) => error.code === 'replay',
  );
  try { client.destroy(); } catch (_) {}
  try { server.close(); } catch (_) {}
});


// (restart hub, decisione Dev): il subject di lancio vive SOLO in memoria nel
// lease manager. Dopo un restart l'entry nuova non ha subject -> il relay e'
// fail-closed: NESSUN proof (stabilito dal mandato; il codice stabile osservato
// e' REVOKED, piu' severo dei codici indicati come esempi).
test('hub restart without the in-memory launch subject stays fail-closed (no proof)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-channel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const authority = createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: () => true,
  });
  // "vita 1": subject impostato, lease viva (contesto reale pre-restart).
  const manager1 = createLeaseManager({ home, log: () => {}, identityAuthority: authority });
  const lease1 = await manager1.track(CELL);
  manager1.setLaunchSubject(CELL, {
    ownerInstanceId: 'owner-a', cellId: CELL, incarnationId: 'incarnation-a', launchEpoch: lease1.launchEpoch,
  });
  // RESTART simulato: processo hub nuovo sulla stessa home. Nessuno ripristina
  // il subject in memoria (non e' persistito): e' lo stato post-restart reale.
  manager1.close();
  const manager2 = createLeaseManager({ home, log: () => {}, identityAuthority: authority });
  t.after(() => manager2.close());
  await manager2.track(CELL);
  const socketPath = path.join(home, 'pair2.sock');
  const server = net.createServer();
  const connected = new Promise((resolve) => server.once('connection', resolve));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = net.createConnection(socketPath);
  const [accepted] = await Promise.all([connected, new Promise((resolve) => client.once('connect', resolve))]);
  assert.equal(manager2.attachInitial(CELL, accepted, { generation: 0 }), true);
  t.after(() => {
    try { client.destroy(); } catch (_) {}
    try { server.close(); } catch (_) {}
  });
  const { raw } = relayFrame(challenge({ nonce: '9'.repeat(64) }), 0);
  client.write(raw);
  const out = await fixReadLine(client);
  assert.equal(out.type, 'challengeProofResult');
  assert.equal(out.ok, false, 'nessun proof dopo restart senza subject');
  assert.equal(out.proof, undefined, 'nessun proof emesso');
  assert.equal(out.reason, 'revoked');
});

test('relay caps a caller-extended challenge window at 15 seconds (R2)', async (t) => {
  const fix = await leaseFixture(t);
  const far = challenge({ nonce: 'e'.repeat(64), issuedAt: Date.now(), expiresAt: Date.now() + 600_000 });
  const { raw } = relayFrame(far);
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, true);
  assert.equal(out.proof.expiresAt - out.proof.issuedAt <= 15_000, true,
    `finestra proof ${out.proof.expiresAt - out.proof.issuedAt}ms > 15000ms: cap server-owned mancante`);
});

test('relay rejects a challenge with issuedAt in the future (R2)', async (t) => {
  const fix = await leaseFixture(t);
  const future = challenge({ nonce: 'f'.repeat(64), issuedAt: Date.now() + 60_000, expiresAt: Date.now() + 90_000 });
  const { raw } = relayFrame(future);
  fix.client.write(raw);
  const out = await fix.reader.next();
  assert.equal(out.ok, false, 'issuedAt nel futuro rifiutato');
});

test('generation transition is announced and accepted on the live lease (R1)', async (t) => {
  const fix = await leaseFixture(t);
  // generazione corrente del fixture: 4 (attachInitial); gen 4: ok
  const g0 = relayFrame(challenge({ nonce: '1'.repeat(64) }), 4);
  fix.client.write(g0.raw);
  const ok0 = await fix.reader.next();
  assert.equal(ok0.ok, true);
  // transizione: annuncio di generazione sulla connessione viva (4 -> 5)
  fix.client.write(`${JSON.stringify({ type: 'generation', generation: 5 })}\n`);
  const ack = await fix.reader.next();
  assert.equal(ack.type, 'generationAck', 'il server conferma la transizione di generazione');
  assert.equal(ack.generation, 5);
  // gen 5: ora deve passare (senza handshake resta REVOKED)
  const g1 = relayFrame(challenge({ nonce: '2'.repeat(64) }), 5);
  fix.client.write(g1.raw);
  const ok1 = await fix.reader.next();
  assert.equal(ok1.ok, true, 'relay della generazione nuova ok dopo handshake');
  // fail-closed invariato: generazione sconosciuta -> revoked
  const g9 = relayFrame(challenge({ nonce: '3'.repeat(64) }), 9);
  fix.client.write(g9.raw);
  const denied = await fix.reader.next();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'revoked');
});
