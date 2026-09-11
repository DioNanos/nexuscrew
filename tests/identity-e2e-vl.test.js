'use strict';

// D-199 NC ↔ VL harness.  This file deliberately does not coerce the NC
// verify-channel challenge into the VL IdentityProof shape.  The negative
// cases are enumerated here while the contract/wiring mismatch is being fixed
// on the VL branch; only the transport smoke is executable at this baseline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');

const CELL = 'DevWorker-d199';
const DAEMON_CREDENTIAL = 'd199-daemon-credential';
const LAUNCHER_CREDENTIAL = 'd199-launcher-credential';
const CELL_EXEC = path.join(__dirname, '..', 'lib', 'fleet', 'cell-exec.js');
const CONTRACT_BLOCK = 'NC↔VL challenge/timestamp shape and VL verifier wiring are not aligned';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d199-e2e-'));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function nextJsonLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('timeout waiting JSON-RPC line')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          finish(null, value);
        } catch (_) {
          finish(new Error(`invalid JSON-RPC stdout: ${line.slice(0, 160)}`));
        }
        return;
      }
    };
    const onEnd = () => finish(new Error('app-server stdout closed'));
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function rpc(child, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (;;) {
    const message = await nextJsonLine(child.stdout);
    if (message.id === id) return message;
  }
}

function fakeVlProof() {
  // Shape only: the real challenge is intentionally not synthesized here.
  // Any conversion would hide the mismatch documented in the report.
  const issued = new Date(Date.now() - 1000).toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  const challenge = {
    version: '1',
    connectionId: 'connection-placeholder',
    daemonBootId: 'boot-placeholder',
    audience: 'daemon/placeholder',
    nonce: 'nonce-placeholder',
    issuedAt: issued,
    expiresAt: expires,
  };
  return {
    version: '1',
    kind: 'connection-v1',
    challenge,
    claims: {
      issuerOwner: 'owner-placeholder',
      audience: challenge.audience,
      ownerInstanceId: 'owner-placeholder',
      cellId: CELL,
      tmuxSession: 'd199-test',
      incarnationId: 'incarnation-placeholder',
      launchEpoch: 'epoch-placeholder',
      daemonBootId: challenge.daemonBootId,
      connectionId: challenge.connectionId,
      bindingId: 'binding-placeholder',
      origin: 'localTui',
      scopes: ['thread/start'],
      issuedAt: issued,
      notBefore: issued,
      expiresAt: expires,
      nonce: challenge.nonce,
    },
    proof: 'not-an-authenticated-proof',
  };
}

async function startHarness(t, { required = true, authorityAlive = true } = {}) {
  const home = tempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const subject = {
    ownerInstanceId: 'owner-d199',
    cellId: CELL,
    incarnationId: 'incarnation-d199',
    launchEpoch: null,
  };
  let verifyCalls = 0;
  const authority = createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: DAEMON_CREDENTIAL,
    launcherCredential: LAUNCHER_CREDENTIAL,
    subjectResolver: (candidate) => Object.entries(subject)
      .filter(([, value]) => value !== null)
      .every(([key, value]) => candidate[key] === value),
  });
  const originalVerify = authority.verifyChallengeProof.bind(authority);
  authority.verifyChallengeProof = (...args) => {
    verifyCalls += 1;
    return originalVerify(...args);
  };
  const manager = createLeaseManager({
    home,
    log: () => {},
    identityAuthority: authorityAlive ? authority : null,
  });
  t.after(() => manager.close());
  const lease = await manager.track(CELL);
  subject.launchEpoch = lease.launchEpoch;
  assert.equal(manager.setLaunchSubject(CELL, subject), true);
  const broker = createLaunchBroker({
    home,
    identityMode: 'authority',
    identityAuthority: authority,
    identityDaemonCredential: DAEMON_CREDENTIAL,
    identityLauncherCredential: LAUNCHER_CREDENTIAL,
    onLease: (socket) => manager.attachInitial(CELL, socket, { generation: 0 }),
  });
  t.after(() => broker.close());

  const bin = process.env.CODEX_APP_SERVER_BIN;
  if (!bin) {
    t.skip('CODEX_APP_SERVER_BIN is absent; real VL binary not selected');
    return null;
  }
  if (!fs.existsSync(bin)) {
    t.skip(`CODEX_APP_SERVER_BIN does not exist: ${bin}`);
    return null;
  }
  const codexHome = path.join(home, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const ticket = await broker.issue({
    command: bin,
    args: ['--disable-plugin-startup-tasks-for-tests'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      CODEX_HOME: codexHome,
      CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1',
      ...(required ? { CODEX_APP_SERVER_IDENTITY_REQUIRED: '1' } : {}),
    },
    supervise: { enabled: false },
    lease: {
      cellId: CELL,
      launchEpoch: lease.launchEpoch,
      stablePath: lease.stablePath,
    },
    identity: {
      audience: 'nexuscrew-lease',
      daemonBootId: 'boot-d199-launch',
      connectionId: 'connection-d199-launch',
      subject,
    },
  });
  const child = spawn(process.execPath, [CELL_EXEC, '--socket', ticket.socketPath, '--nonce', ticket.nonce], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  t.after(async () => {
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await waitForExit(child).catch(() => {});
  });
  let initialized;
  try {
    initialized = await rpc(child, 1, 'initialize', {
    clientInfo: { name: 'd199-e2e', version: '0.1.0' },
    capabilities: { extensions: { 'nexuscrew.identity.v1': {} } },
    });
  } catch (error) {
    error.message += `; child stderr: ${stderr}`;
    throw error;
  }
  assert.equal(initialized.error, undefined, `initialize failed: ${JSON.stringify(initialized)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  return {
    child,
    authority,
    verifyCalls: () => verifyCalls,
    fakeProof: fakeVlProof(),
    required,
    authorityAlive,
  };
}

const NEGATIVE_CASES = [
  ['2-forged-hmac', 'IDENTITY_UNVERIFIED', { mutate: (proof) => { proof.proof = 'f'.repeat(64); } }],
  ['3-tampered-claims', 'IDENTITY_UNVERIFIED', { mutate: (proof) => { proof.claims.cellId = 'tampered'; } }],
  ['4-replay', 'REPLAY', {}],
  ['5-authority-stopped', 'IDENTITY_UNVERIFIED', { authorityAlive: false }],
  ['6-identity-required-off', 'NO_VERIFY_CALL', { required: false }],
  ['7-valid-claims-unauthenticated-proof', 'IDENTITY_UNVERIFIED', {}],
];

test('D-199 e2e harness boots real authority + lease + cell-exec + VL app-server', async (t) => {
  const harness = await startHarness(t);
  if (!harness) return;
  assert.equal(harness.required, true);
  const result = await rpc(harness.child, 2, 'nexuscrew/identity/bind', { proof: harness.fakeProof });
  assert.ok(result.error, `baseline must not create an unverified privileged binding: ${JSON.stringify(result)}`);
  assert.equal(harness.verifyCalls(), 0,
    'baseline a9e09b4 has no verifier wiring; this is a smoke observation, not proof of authority semantics');
  harness.child.stdin.end();
  const exited = await waitForExit(harness.child);
  assert.equal(exited.signal, null);
});

for (const [name, expected, options] of NEGATIVE_CASES) {
  test(`D-199 case ${name}`, { skip: CONTRACT_BLOCK }, async () => {
    assert.equal(typeof expected, 'string');
    assert.equal(typeof options, 'object');
  });
}
