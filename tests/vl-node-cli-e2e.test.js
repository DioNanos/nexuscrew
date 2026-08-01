'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const VL_BIN = process.env.VL_E2E_BIN;

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function runVl(args, { env = process.env, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(VL_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`vl timed out: ${args.join(' ')}`));
    }, timeout);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

test('compiled VL pairs, manages one cell, reconnects and exits stale session fail-closed', {
  skip: !VL_BIN || !fs.existsSync(VL_BIN) ? 'set VL_E2E_BIN to a compiled vl binary' : false,
  timeout: 30_000,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-cli-'));
  const stateDir = path.join(home, 'device-state');
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  const vlNodesPath = path.join(configDir, 'vl-nodes.json');
  const tokenPath = path.join(configDir, 'token');
  const ownerId = 'a'.repeat(32);
  nodesStore.atomicWriteStore(nodesPath, nodesStore.emptyStore(ownerId));

  let made;
  const startServer = async (port = 0) => {
    made = createServer({
      home, configDir, nodesPath, vlNodesPath, tokenPath,
      filesRoot: path.join(home, 'files'), fleetEnabled: false, autoUpdate: false,
      bind: '127.0.0.1', port, log: () => {},
    });
    await new Promise((resolve) => made.server.listen(port, '127.0.0.1', resolve));
    return made.server.address().port;
  };
  const port = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const uiToken = fs.readFileSync(tokenPath, 'utf8').trim();
  const ui = { authorization: `Bearer ${uiToken}`, 'content-type': 'application/json' };

  let supervisor = null;
  t.after(async () => {
    supervisor?.kill('SIGTERM');
    if (made?.server?.listening) await closeServer(made.server);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const inviteResponse = await fetch(`${base}/api/vl-nodes/invite`, {
    method: 'POST', headers: ui, body: JSON.stringify({ label: 'N900', ttlSeconds: 60 }),
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const paired = await runVl([
    'node', 'pair', '--broker', `${base}/`, '--label', 'N900', '--state-dir', stateDir,
  ], {
    env: { ...process.env, VL_NODE_INVITE: invite.invite },
  });
  assert.equal(paired.status, 0, paired.stderr);
  const pairResult = JSON.parse(paired.stdout);
  assert.equal(pairResult.ownerId, ownerId);
  assert.ok(!paired.stdout.includes(invite.invite), 'pair output must not echo invite');
  const secretText = fs.readFileSync(path.join(stateDir, 'secrets.env'), 'utf8');
  const nodeToken = secretText.match(/^VL_NODE_TOKEN=([a-f0-9]{64})$/m)?.[1];
  assert.ok(nodeToken, 'scoped token persisted only in device-local secret file');

  let stderr = '';
  supervisor = spawn(VL_BIN, ['node', 'run', '--state-dir', stateDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  supervisor.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const listed = await waitFor(async () => {
    const response = await fetch(`${base}/api/vl-nodes`, { headers: ui });
    const body = await response.json();
    return body.nodes[0]?.online ? body.nodes[0] : null;
  }, 'VL supervisor never became online');
  const nodeId = listed.nodeId;
  assert.equal(listed.health.processCount, 2);
  assert.equal(listed.health.state, 'running');
  assert.ok(listed.health.rssBytes > 0, 'health must report supervisor + child RSS');
  if (process.env.VL_E2E_SHOW_METRICS === '1') {
    process.stdout.write(`# VL_E2E_METRICS ${JSON.stringify({
      processCount: listed.health.processCount,
      rssBytes: listed.health.rssBytes,
      state: listed.health.state,
      brokerReachable: listed.health.brokerReachable,
    })}\n`);
  }

  const duplicate = await runVl(['node', 'run', '--state-dir', stateDir], { timeout: 5000 });
  assert.notEqual(duplicate.status, 0, 'second local supervisor must fail');
  assert.match(duplicate.stderr, /node-supervisor-already-running/);

  const command = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'restart', args: {} }),
  });
  assert.equal(command.status, 202);
  const receipt = await command.json();
  const ack = await waitFor(async () => {
    const body = await (await fetch(`${base}/api/vl-nodes`, { headers: ui })).json();
    return body.nodes[0]?.lastAck?.id === receipt.id ? body.nodes[0].lastAck : null;
  }, 'restart completion ack missing');
  assert.equal(ack.status, 'ok');
  assert.equal(ack.result.state, 'running');

  const candidateBytes = Buffer.from('bounded-vl-candidate-test');
  const candidateSha = crypto.createHash('sha256').update(candidateBytes).digest('hex');
  const assets = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': candidateBytes.length });
    res.end(candidateBytes);
  });
  await new Promise((resolve) => assets.listen(0, '127.0.0.1', resolve));
  const update = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui,
    body: JSON.stringify({
      kind: 'update_candidate', args: {
        url: `http://127.0.0.1:${assets.address().port}/vl`, sha256: candidateSha,
        size: candidateBytes.length, version: 'e2e-test',
      },
    }),
  });
  assert.equal(update.status, 202);
  const updateReceipt = await update.json();
  const updateAck = await waitFor(async () => {
    const body = await (await fetch(`${base}/api/vl-nodes`, { headers: ui })).json();
    return body.nodes[0]?.lastAck?.id === updateReceipt.id ? body.nodes[0].lastAck : null;
  }, 'candidate staging ack missing');
  await new Promise((resolve) => assets.close(resolve));
  assert.equal(updateAck.status, 'ok');
  assert.equal(updateAck.result.activated, false);
  assert.equal(updateAck.result.sha256, candidateSha);
  assert.deepEqual(fs.readFileSync(path.join(stateDir, 'candidates', 'vl.candidate')), candidateBytes);

  await closeServer(made.server);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await startServer(port);
  await waitFor(async () => {
    const body = await (await fetch(`${base}/api/vl-nodes`, { headers: ui })).json();
    return body.nodes[0]?.online;
  }, 'VL did not reconnect after broker restart');

  const supersedingPoll = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json', 'x-vl-wait-ms': '1',
    },
    body: JSON.stringify({
      protocol: 'vl-node/1', nodeId, sessionId: 'f'.repeat(32), seq: 0,
      version: 'test', capabilities: [],
      health: {
        state: 'running', uptimeSec: 1, rssBytes: 1, processCount: 1,
        brokerReachable: true, childPid: null, batteryPercent: -1, detail: 'superseding test',
      },
    }),
  });
  assert.equal(supersedingPoll.status, 204);
  const exit = await new Promise((resolve) => supervisor.once('exit', (code, signal) => resolve({ code, signal })));
  assert.notEqual(exit.code, 0, 'superseded supervisor must exit fail-closed');
  assert.match(stderr, /node-session-superseded/);
  assert.ok(!stderr.includes(nodeToken), 'diagnostics must not contain scoped credential');

  stderr = '';
  supervisor = spawn(VL_BIN, ['node', 'run', '--state-dir', stateDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  supervisor.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitFor(async () => {
    const body = await (await fetch(`${base}/api/vl-nodes`, { headers: ui })).json();
    return body.nodes[0]?.online;
  }, 'fresh supervisor did not recover after stale-session shutdown');

  const cleanExit = new Promise((resolve) => supervisor.once('exit', (code, signal) => resolve({ code, signal })));
  const unpair = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'unpair', args: {} }),
  });
  assert.equal(unpair.status, 202);
  await waitFor(async () => {
    const body = await (await fetch(`${base}/api/vl-nodes`, { headers: ui })).json();
    return body.nodes.length === 0;
  }, 'unpair was not acked and revoked');
  assert.deepEqual(await cleanExit, { code: 0, signal: null });
  supervisor = null;
  assert.ok(!fs.readFileSync(path.join(stateDir, 'secrets.env'), 'utf8').includes('VL_NODE_TOKEN='));
});
