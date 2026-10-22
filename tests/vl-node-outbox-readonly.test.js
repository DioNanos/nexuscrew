'use strict';

// A read-only server delivers nothing: the outbox of a node must be refused
// with the same gate of the send route, before any delivery.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processOutbox, createRateLimiter, sanitizeOutboxItem } = require('../lib/vl-nodes/outbox.js');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const vlNodesStore = require('../lib/vl-nodes/store.js');

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-outbox-readonly-'));
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

test('a read-only server refuses the outbox with rejected:readonly and delivers nothing', async () => {
  const h = makeHarness();
  try {
    const result = await processOutbox({
      ...h.ctx,
      readonly: () => true,
      outbox: [{ id: 'c'.repeat(32), to: `${h.owner}:Dev`, text: 'TEST_ONLY_MESSAGE' }],
    });
    assert.equal(result.outcomes[0].outcome, 'rejected:readonly');
    assert.equal(result.cursor, `${'c'.repeat(32)}:rejected:readonly`);
    assert.equal(h.deliveries(), 0, 'a read-only server delivers nothing');
  } finally {
    h.cleanup();
  }
});

test('the same outbox is delivered when the server is not read-only', async () => {
  const h = makeHarness();
  try {
    const result = await processOutbox({
      ...h.ctx,
      readonly: () => false,
      outbox: [{ id: 'd'.repeat(32), to: `${h.owner}:Dev`, text: 'TEST_ONLY_MESSAGE' }],
    });
    assert.equal(result.outcomes[0].outcome, 'submitted');
    assert.equal(h.deliveries(), 1);
  } finally {
    h.cleanup();
  }
});

test('the outbox text is validated with the rule of the send route', async () => {
  const h = makeHarness();
  try {
    // An empty text is not a cell message: the send route refuses it too.
    const empty = await processOutbox({
      ...h.ctx,
      outbox: [{ id: 'e'.repeat(32), to: `${h.owner}:Dev`, text: '' }],
    });
    assert.equal(empty.outcomes[0].outcome, 'rejected:invalid-text');
    assert.equal(h.deliveries(), 0);
    // A plain text still passes.
    assert.equal(sanitizeOutboxItem({ id: 'f'.repeat(32), to: `${h.owner}:Dev`, text: 'ok' }).error, null);
  } finally {
    h.cleanup();
  }
});

// --- the same gate on the real HTTP surface -------------------------------

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

test('the HTTP poll of a node is refused on a read-only server and delivered when it is writable', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-readonly-http-'));
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
  const mockFleet = {
    cellStatus: async () => ({
      available: true,
      cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, tmux: true, engine: 'claude.native' }],
    }),
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

  // 1. Read-only server: the outbox is refused, nothing is delivered.
  process.env.NEXUSCREW_READONLY = '1';
  const refusedId = '3'.repeat(32);
  const refused = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, 'd'.repeat(32), 0, {
      outbox: [{ id: refusedId, to: `${ownerId}:Dev`, text: 'first attempt' }],
    })),
  });
  assert.equal(refused.headers.get('x-vl-outbox-cursor'), `${refusedId}:rejected:readonly`);
  assert.equal(deliveredMessages.length, 0, 'a read-only server delivers nothing');

  // 2. Writable server, new message: the same path delivers.
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
  assert.equal(deliveredMessages[0].session, 'cloud-Dev');
});
