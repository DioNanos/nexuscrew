'use strict';

// A read-only server delivers nothing: the outbox of a node must be refused
// even when the read-only gate rises WHILE the fleet directory is resolving.
// The gate is read at the entry of the settlement and again immediately
// before the delivery, so a gate that rises during the wait stops it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processOutbox, createRateLimiter } = require('../lib/vl-nodes/outbox.js');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const vlNodesStore = require('../lib/vl-nodes/store.js');

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-outbox-readonly-race-'));
  const file = path.join(home, 'vl-nodes.json');
  const owner = 'a'.repeat(32);
  const nodeId = 'b'.repeat(32);
  const invite = vlNodesStore.createInvite(file, { label: 'synthetic' });
  const paired = vlNodesStore.pairNode(file, {
    invite: invite.invite,
    nodeId,
    version: 'test',
    capabilities: [],
  });
  assert.ok(paired.ok, 'pairing must succeed');
  vlNodesStore.setNodeAcl(file, nodeId, { allowCells: ['Dev'] });
  let deliveries = 0;
  const ctx = {
    node: { nodeId },
    storePath: file,
    ownerId: owner,
    fleetStatus: {
      available: true,
      cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, tmux: true, engine: 'mock' }],
    },
    submit: async () => {
      deliveries += 1;
      return { submitted: true };
    },
    rateLimiter: createRateLimiter(),
    now: Date.now,
  };
  return {
    home,
    file,
    owner,
    nodeId,
    ctx,
    deliveries: () => deliveries,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test('the outbox refuses the delivery when the read-only gate rises while the directory resolves', async () => {
  const h = makeHarness();
  try {
    let release;
    let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    let gate = false;
    const item = { id: 'c'.repeat(32), to: `${h.owner}:Dev`, text: 'TEST_ONLY_MESSAGE' };
    const pending = processOutbox({
      ...h.ctx,
      outbox: [item],
      readonly: () => gate,
      fleetStatus: async () => {
        entered();
        await barrier;
        return h.ctx.fleetStatus;
      },
    });
    await waiting;
    // The gate rises while the directory is resolving: the delivery that
    // follows must not happen.
    gate = true;
    release();
    const result = await pending;
    assert.equal(result.outcomes[0].outcome, 'rejected:readonly');
    assert.equal(result.cursor, `${item.id}:rejected:readonly`);
    assert.equal(h.deliveries(), 0, 'a read-only server delivers nothing');
  } finally {
    h.cleanup();
  }
});

test('the same outbox is delivered when the gate stays down during the resolution', async () => {
  const h = makeHarness();
  try {
    let release;
    let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    let gate = false;
    const item = { id: 'd'.repeat(32), to: `${h.owner}:Dev`, text: 'TEST_ONLY_MESSAGE' };
    const pending = processOutbox({
      ...h.ctx,
      outbox: [item],
      readonly: () => gate,
      fleetStatus: async () => {
        entered();
        await barrier;
        return h.ctx.fleetStatus;
      },
    });
    await waiting;
    release();
    const result = await pending;
    assert.equal(result.outcomes[0].outcome, 'submitted');
    assert.equal(h.deliveries(), 1, 'a writable server delivers the outbox');
  } finally {
    h.cleanup();
  }
});

// --- the same race on the real HTTP surface -------------------------------

function heartbeat(nodeId, sessionId, seq, extra = {}) {
  return {
    protocol: 'vl-node/1',
    nodeId,
    sessionId,
    seq,
    version: '0.1.0',
    capabilities: ['status', 'health'],
    health: { state: 'running', uptimeSec: 10, rssBytes: 1024, processCount: 2, brokerReachable: true, childPid: 1, batteryPercent: 80, detail: 'poll active' },
    ...extra,
  };
}

test('the HTTP poll of a node is refused when the gate rises while the directory resolves', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-readonly-race-http-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  const vlNodesPath = path.join(configDir, 'vl-nodes.json');
  const tokenPath = path.join(configDir, 'token');
  const ownerId = 'a'.repeat(32);
  nodesStore.atomicWriteStore(nodesPath, nodesStore.emptyStore(ownerId));

  const deliveredMessages = [];
  const mockSubmit = async (session, text, meta) => {
    deliveredMessages.push({ session, text, meta });
    return { submitted: true };
  };

  // The directory resolution is suspended by the test: the poll waits on it
  // and the test raises the read-only gate in the meantime.
  let barrier = null;
  let entered = null;
  const mockFleet = {
    cellStatus: async () => {
      if (barrier) {
        const wait = barrier;
        barrier = null;
        entered();
        await wait;
      }
      return {
        available: true,
        cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, tmux: true, engine: 'claude.native' }],
      };
    },
  };

  const made = createServer({
    protectSharedTmuxServer: false,
    home,
    configDir,
    nodesPath,
    vlNodesPath,
    tokenPath,
    filesRoot: path.join(home, 'files'),
    fleetEnabled: false,
    autoUpdate: false,
    bind: '127.0.0.1',
    port: 0,
    log: () => {},
    cellSubmit: mockSubmit,
    fleetP: Promise.resolve(mockFleet),
  });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    delete process.env.NEXUSCREW_READONLY;
    await new Promise((resolve) => made.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${made.server.address().port}`;
  const uiToken = fs.readFileSync(tokenPath, 'utf8').trim();
  const ui = { authorization: `Bearer ${uiToken}`, 'content-type': 'application/json' };

  const invite = (await (await fetch(`${base}/api/vl-nodes/invite`, {
    method: 'POST', headers: ui, body: JSON.stringify({ label: 'Kobo' }),
  })).json()).invite;

  const nodeId = 'c'.repeat(32);
  const paired = await (await fetch(`${base}/vl-node/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vl-invite': invite },
    body: JSON.stringify({ protocol: 'vl-node/1', nodeId, label: 'Kobo' }),
  })).json();
  await fetch(`${base}/api/vl-nodes/${nodeId}/acl`, {
    method: 'PUT', headers: ui, body: JSON.stringify({ allowCells: ['Dev'] }),
  });

  const nodeHeaders = {
    authorization: `Bearer ${paired.token}`,
    'content-type': 'application/json',
    'x-vl-wait-ms': '50',
  };

  // The gate rises while the poll waits for the directory: the delivery that
  // follows must be refused, with the outcome of the other refusals.
  let release;
  const gateBarrier = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  barrier = gateBarrier;
  const refusedId = '3'.repeat(32);
  const pending = fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, 'd'.repeat(32), 0, {
      outbox: [{ id: refusedId, to: `${ownerId}:Dev`, text: 'first attempt' }],
    })),
  });
  await waiting;
  process.env.NEXUSCREW_READONLY = '1';
  release();
  const refused = await pending;
  assert.equal(refused.headers.get('x-vl-outbox-cursor'), `${refusedId}:rejected:readonly`);
  assert.equal(deliveredMessages.length, 0, 'a read-only server delivers nothing');

  // Control: the same path, with the gate down again, delivers.
  delete process.env.NEXUSCREW_READONLY;
  const deliveredId = '4'.repeat(32);
  const delivered = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, 'd'.repeat(32), 1, {
      outbox: [{ id: deliveredId, to: `${ownerId}:Dev`, text: 'second attempt' }],
    })),
  });
  assert.equal(delivered.headers.get('x-vl-outbox-cursor'), `${deliveredId}:submitted`);
  assert.equal(deliveredMessages.length, 1, 'the writable server delivers the outbox');
});
