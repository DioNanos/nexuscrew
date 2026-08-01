'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function heartbeat(nodeId, sessionId, seq, ack = undefined) {
  return {
    protocol: 'vl-node/1', nodeId, sessionId, seq, version: '0.1.0',
    capabilities: ['status', 'health'],
    health: {
      state: 'running', uptimeSec: 10, rssBytes: 1024, processCount: 2,
      brokerReachable: true, childPid: 123, batteryPercent: 80, detail: 'poll active',
    },
    ...(ack ? { ack } : {}),
  };
}

test('real HTTP server pairs, delivers live-only, acks, supersedes stale session and revokes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-http-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  const vlNodesPath = path.join(configDir, 'vl-nodes.json');
  const tokenPath = path.join(configDir, 'token');
  const ownerId = 'a'.repeat(32);
  nodesStore.atomicWriteStore(nodesPath, nodesStore.emptyStore(ownerId));
  const made = createServer({
    home, configDir, nodesPath, vlNodesPath, tokenPath,
    filesRoot: path.join(home, 'files'), fleetEnabled: false, autoUpdate: false,
    bind: '127.0.0.1', port: 0, log: () => {},
  });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => made.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const uiToken = fs.readFileSync(tokenPath, 'utf8').trim();
  const ui = { authorization: `Bearer ${uiToken}`, 'content-type': 'application/json' };

  const malformedPair = await fetch(`${base}/vl-node/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ nope',
  });
  assert.equal(malformedPair.status, 400);
  assert.match(malformedPair.headers.get('content-type') || '', /^application\/json/);
  const malformedBody = await malformedPair.text();
  assert.deepEqual(JSON.parse(malformedBody), { error: 'invalid JSON' });
  assert.doesNotMatch(malformedBody, /\/home\/|node_modules|SyntaxError|\bat\s+\w/);

  const inviteResponse = await fetch(`${base}/api/vl-nodes/invite`, {
    method: 'POST', headers: ui, body: JSON.stringify({ label: 'N900', ttlSeconds: 60 }),
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await json(inviteResponse);
  assert.equal(invite.ownerId, ownerId);

  const nodeId = 'b'.repeat(32);
  const pairResponse = await fetch(`${base}/vl-node/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-vl-invite': invite.invite },
    body: JSON.stringify({ protocol: 'vl-node/1', nodeId, label: 'N900' }),
  });
  assert.equal(pairResponse.status, 201);
  const paired = await json(pairResponse);
  assert.match(paired.token, /^[a-f0-9]{64}$/);
  assert.ok(!fs.readFileSync(vlNodesPath, 'utf8').includes(paired.token), 'plaintext token never persists');
  const node = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const offline = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'status', args: {} }),
  });
  assert.equal(offline.status, 409, 'no poll means no invented offline queue');

  const poll = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '30000' },
    body: JSON.stringify(heartbeat(nodeId, 'c'.repeat(32), 0)),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const submitted = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'status', args: {} }),
  });
  assert.equal(submitted.status, 202);
  const receipt = await json(submitted);
  assert.equal(receipt.status, 'submitted');
  const delivered = await json(await poll);
  assert.equal(delivered.command.id, receipt.id);
  assert.equal(delivered.command.kind, 'status');

  const ackResponse = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '1' },
    body: JSON.stringify(heartbeat(nodeId, 'c'.repeat(32), 1, {
      id: receipt.id, status: 'ok', result: { cellRunning: true },
    })),
  });
  assert.equal(ackResponse.status, 204);
  const listed = await json(await fetch(`${base}/api/vl-nodes`, { headers: ui }));
  assert.equal(listed.nodes[0].lastAck.id, receipt.id);
  assert.equal(listed.nodes[0].lastAck.status, 'ok');

  const lostResponsePoll = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '30000' },
    body: JSON.stringify(heartbeat(nodeId, 'c'.repeat(32), 2)),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const uncertain = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'restart', args: {} }),
  });
  assert.equal(uncertain.status, 202);
  const uncertainReceipt = await json(uncertain);
  assert.equal((await json(await lostResponsePoll)).command.id, uncertainReceipt.id);

  const recoveryPoll = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '30000' },
    body: JSON.stringify(heartbeat(nodeId, 'c'.repeat(32), 3)),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const recovered = await json(await fetch(`${base}/api/vl-nodes`, { headers: ui }));
  assert.equal(recovered.nodes[0].inflight, null);
  assert.equal(recovered.nodes[0].lastAck.id, uncertainReceipt.id);
  assert.equal(recovered.nodes[0].lastAck.status, 'error');
  assert.equal(recovered.nodes[0].lastAck.result.code, 'delivery-unknown');

  const afterUnknown = await fetch(`${base}/api/vl-nodes/${nodeId}/commands`, {
    method: 'POST', headers: ui, body: JSON.stringify({ kind: 'health', args: {} }),
  });
  assert.equal(afterUnknown.status, 202);
  const afterUnknownReceipt = await json(afterUnknown);
  assert.equal((await json(await recoveryPoll)).command.id, afterUnknownReceipt.id);
  const recoveryAck = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '1' },
    body: JSON.stringify(heartbeat(nodeId, 'c'.repeat(32), 4, {
      id: afterUnknownReceipt.id, status: 'ok', result: { brokerReachable: true },
    })),
  });
  assert.equal(recoveryAck.status, 204);

  const stalePoll = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '30000' },
    body: JSON.stringify(heartbeat(nodeId, 'd'.repeat(32), 0)),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const freshPoll = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '1' },
    body: JSON.stringify(heartbeat(nodeId, 'e'.repeat(32), 0)),
  });
  assert.equal((await stalePoll).status, 409);
  assert.equal((await freshPoll).status, 204);

  const unpair = await fetch(`${base}/vl-node/v1/unpair`, {
    method: 'POST', headers: node,
    body: JSON.stringify({ protocol: 'vl-node/1', nodeId }),
  });
  assert.equal(unpair.status, 204);
  const rejected = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST', headers: { ...node, 'x-vl-wait-ms': '1' },
    body: JSON.stringify(heartbeat(nodeId, 'f'.repeat(32), 0)),
  });
  assert.equal(rejected.status, 401);
});
