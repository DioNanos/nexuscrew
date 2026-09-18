'use strict';

// NC ↔ VL harness. The NC proof remains the authority-owned opaque
// payload inside the VL IdentityProof; the harness only supplies the
// non-authoritative structural claims required by the VL bind boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');

const CELL = 'e2e-cell-d199';
const DAEMON_CREDENTIAL = 'd199-daemon-credential';
const LAUNCHER_CREDENTIAL = 'd199-launcher-credential';
const CELL_EXEC = path.join(__dirname, '..', 'lib', 'fleet', 'cell-exec.js');
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

async function waitForChallenge(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) return JSON.parse(lines[lines.length - 1]);
    } catch (_) {
      // The daemon writes the fixture after initialize; keep the bounded wait.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`identity challenge fixture not written: ${file}`);
}

function vlProof(challenge, rawProof, subject, { rawOverride = rawProof } = {}) {
  return {
    version: '1',
    kind: 'connection-v1',
    challenge,
    claims: {
      issuerOwner: subject.ownerInstanceId,
      audience: challenge.audience,
      ownerInstanceId: subject.ownerInstanceId,
      cellId: subject.cellId,
      tmuxSession: rawProof.tmuxSession,
      incarnationId: subject.incarnationId,
      launchEpoch: rawProof.launchEpoch,
      daemonBootId: challenge.daemonBootId,
      connectionId: challenge.connectionId,
      bindingId: rawProof.bindingId,
      origin: 'local_tui',
      scopes: rawProof.scopes,
      issuedAt: rawProof.issuedAt,
      notBefore: rawProof.issuedAt,
      expiresAt: rawProof.expiresAt,
      nonce: rawProof.nonce,
    },
    // The outer numeric generation is also signed into the NC raw proof.
    proof: JSON.stringify({ generation: rawProof.generation, proof: rawOverride }),
  };
}

async function startHarness(t, { required = true, authorityAlive = true, fixture = true } = {}) {
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
      ...(fixture ? { D174_IDENTITY_CHALLENGE_FILE: path.join(home, 'identity-challenges.jsonl') } : {}),
      RUST_LOG: 'warn',
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
  const challenge = fixture
    ? await waitForChallenge(path.join(home, 'identity-challenges.jsonl'))
    : initialized.result?.identityChallenge;
  const issued = challenge ? authority.issueConnectionProof({ subject, challenge, generation: 0 }) : null;
  if (fixture) {
    assert.equal(issued.ok, true, `authority must issue the fixture proof: ${JSON.stringify(issued)}`);
  }
  return {
    child,
    stderr: () => stderr,
    authority,
    subject,
    challenge,
    initialized,
    rawProof: issued?.proof,
    verifyCalls: () => verifyCalls,
    required,
    authorityAlive,
  };
}

async function bindProof(harness, proof) {
  return rpc(harness.child, 2, 'nexuscrew/identity/bind', { proof });
}

function assertBindError(result, expected) {
  assert.equal(result.error?.message, `identity bind failed: ${expected}`, JSON.stringify(result));
}

function proofFor(harness, options = {}) {
  const raw = { ...harness.rawProof, ...(options.raw || {}) };
  return vlProof(harness.challenge, harness.rawProof, harness.subject, { rawOverride: raw });
}

// These six negative cases deliberately use the production challenge
// from InitializeResponse. They must not depend on D174_IDENTITY_CHALLENGE_FILE.
test('case 2 forged HMAC is rejected on production path', async (t) => {
  const harness = await startHarness(t, { fixture: false });
  if (!harness) return;
  const result = await bindProof(harness, proofFor(harness, { raw: { proof: 'f'.repeat(64) } }));
  assertBindError(result, 'IdentityUnverified');
  assert.equal(harness.verifyCalls(), 1);
});

test('case 3 tampered claims are rejected on production path', async (t) => {
  const harness = await startHarness(t, { fixture: false });
  if (!harness) return;
  const result = await bindProof(harness, proofFor(harness, { raw: { cellId: 'tampered' } }));
  assertBindError(result, 'IdentityUnverified');
  assert.equal(harness.verifyCalls(), 1);
});

test('case 4 replay is rejected on production path', async (t) => {
  const harness = await startHarness(t, { fixture: false });
  if (!harness) return;
  const proof = proofFor(harness);
  const first = await bindProof(harness, proof);
  assert.equal(first.error, undefined, JSON.stringify(first));
  const second = await bindProof(harness, proof);
  assertBindError(second, 'Replay');
  assert.equal(harness.verifyCalls(), 1);
});

test('case 5 authority stopped within verify timeout is rejected on production path', async (t) => {
  const harness = await startHarness(t, { authorityAlive: false, fixture: false });
  if (!harness) return;
  const result = await bindProof(harness, proofFor(harness));
  assertBindError(result, 'IdentityUnverified');
  assert.equal(harness.verifyCalls(), 0);
});

test('case 6 identity required OFF does not call verify on production path', async (t) => {
  const harness = await startHarness(t, { required: false, fixture: false });
  if (!harness) return;
  const result = await bindProof(harness, proofFor(harness));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(harness.verifyCalls(), 0);
});

test('case 7 valid claims with unauthenticated proof are rejected on production path', async (t) => {
  const harness = await startHarness(t, { fixture: false });
  if (!harness) return;
  const result = await bindProof(harness, proofFor(harness, { raw: { proof: 'not-authenticated' } }));
  assertBindError(result, 'IdentityUnverified');
  assert.equal(harness.verifyCalls(), 1);
});

test('production path challenge binds without the test fixture', async (t) => {
  const harness = await startHarness(t, { fixture: false });
  if (!harness) return;
  assert.deepEqual(Object.keys(harness.initialized.result?.identityChallenge ?? {}).sort(), [
    'audience', 'connectionId', 'daemonBootId', 'expiresAt', 'issuedAt', 'nonce', 'version',
  ]);
  const result = await bindProof(harness, proofFor(harness));
  assert.equal(result.error, undefined, `real challenge proof must bind: ${JSON.stringify(result)} stderr=${harness.stderr()}`);
});
