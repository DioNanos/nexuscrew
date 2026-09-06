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
  request.write(identityRpc(5));
  assert.equal(timers.length, 1);
  timers[0]();
  const out = await reader.next();
  assert.equal(out.error.data.code, 'AUTHORITY_UNAVAILABLE');
  assert.equal(channel.isClosed(), false);
  channel.close();
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

async function leaseFixture(t, { withAuthority = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-channel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let subject = null;
  const authority = withAuthority ? createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => !!subject
      && Object.entries(subject).every(([key, value]) => candidate[key] === value),
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
