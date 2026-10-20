'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatCellEnvelope } = require('../lib/cells/deliver.js');
const {
  sanitizeOutboxItem,
  createRateLimiter,
  MAX_OUTBOX_TEXT,
  RATE_LIMIT_MINUTE_CAP,
  RATE_LIMIT_HOUR_CAP,
} = require('../lib/vl-nodes/outbox.js');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function heartbeat(nodeId, sessionId, seq, extra = {}) {
  return {
    protocol: 'vl-node/1',
    nodeId,
    sessionId,
    seq,
    version: '0.1.0',
    capabilities: ['status', 'health'],
    health: {
      state: 'running',
      uptimeSec: 10,
      rssBytes: 1024,
      processCount: 2,
      brokerReachable: true,
      childPid: 123,
      batteryPercent: 80,
      detail: 'poll active',
    },
    ...extra,
  };
}

test('formatCellEnvelope formats exact delimiter lines and label', () => {
  const env = formatCellEnvelope({
    id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    label: 'VL-12345678@abcd1234',
    text: 'Hello from micro node',
  });
  assert.equal(
    env,
    '[NexusCrew message a1b2c3d4e5f60718293a4b5c6d7e8f90 from VL-12345678@abcd1234]\nHello from micro node\n[End NexusCrew message]'
  );
});

test('sanitizeOutboxItem enforces bounds, control chars, and deny-extra fields', () => {
  const valid = {
    id: 'a'.repeat(32),
    to: `${'b'.repeat(32)}:Dev`,
    text: 'hello world',
  };
  const { item, error } = sanitizeOutboxItem(valid);
  assert.equal(error, null);
  assert.deepEqual(item, valid);

  // Oversize > 2048 bytes
  const oversized = { ...valid, text: 'x'.repeat(MAX_OUTBOX_TEXT + 1) };
  assert.equal(sanitizeOutboxItem(oversized).error, 'oversized');

  // Control characters outside tab, newline, cr
  const withBell = { ...valid, text: 'hello\x07world' };
  assert.equal(sanitizeOutboxItem(withBell).error, 'control-chars');

  // Tab, LF, CR are accepted
  const allowedControls = { ...valid, text: 'line1\r\n\tline2' };
  assert.equal(sanitizeOutboxItem(allowedControls).error, null);

  // Extra unknown fields rejected
  const withExtra = { ...valid, evilKey: true };
  assert.equal(sanitizeOutboxItem(withExtra).error, 'unknown-field');

  // 'from' in payload is ignored (stripped from item)
  const withFrom = { ...valid, from: 'Impersonated' };
  const fromCleaned = sanitizeOutboxItem(withFrom);
  assert.equal(fromCleaned.error, null);
  assert.equal(fromCleaned.item.from, undefined);
  assert.equal(fromCleaned.item.text, 'hello world');
});

test('rateLimiter enforces 6 per minute and 20 per hour per node', () => {
  const limiter = createRateLimiter();
  const nodeId = 'n1';
  let now = 1_000_000;

  // 6 in first minute: all pass
  for (let i = 0; i < RATE_LIMIT_MINUTE_CAP; i++) {
    assert.equal(limiter.checkAndConsume(nodeId, now + i * 1000), true);
  }
  // 7th in same minute: rejected
  assert.equal(limiter.checkAndConsume(nodeId, now + 6500), false);

  // Advance by 61 seconds (new minute window): allowed
  now += 61_000;
  assert.equal(limiter.checkAndConsume(nodeId, now), true);

  // Push total up to 20 for the hour
  let hourNow = now + 1000;
  // Currently we have 6 + 1 = 7. Consume 13 more
  for (let i = 0; i < 13; i++) {
    hourNow += 65_000; // spread across minutes
    assert.equal(limiter.checkAndConsume(nodeId, hourNow), true);
  }

  // 21st message in the hour: rejected
  hourNow += 65_000;
  assert.equal(limiter.checkAndConsume(nodeId, hourNow), false);

  // Advance past 1 hour: allowed again
  hourNow += 3_600_000;
  assert.equal(limiter.checkAndConsume(nodeId, hourNow), true);
});

test('real HTTP server: ACL default-deny, PUT acl, delivery, cursor header, from ignored, remote rejected', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-outbox-http-'));
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
      cells: [
        { cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, tmux: true, engine: 'claude.native' },
        { cell: 'SysAdmin', tmuxSession: 'cloud-SysAdmin', active: true, tmux: true, engine: 'claude.native' },
        { cell: 'InactiveCell', tmuxSession: 'cloud-Inactive', active: false, tmux: false },
      ],
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
    await new Promise((resolve) => made.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${made.server.address().port}`;
  const uiToken = fs.readFileSync(tokenPath, 'utf8').trim();
  const ui = { authorization: `Bearer ${uiToken}`, 'content-type': 'application/json' };

  // 1. Create Invite and Pair node
  const inviteRes = await fetch(`${base}/api/vl-nodes/invite`, {
    method: 'POST',
    headers: ui,
    body: JSON.stringify({ label: 'Kobo' }),
  });
  const invite = (await json(inviteRes)).invite;

  const nodeId = 'c'.repeat(32);
  const pairRes = await fetch(`${base}/vl-node/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vl-invite': invite },
    body: JSON.stringify({ protocol: 'vl-node/1', nodeId, label: 'Kobo' }),
  });
  const paired = await json(pairRes);
  const nodeToken = paired.token;
  const nodeHeaders = {
    authorization: `Bearer ${nodeToken}`,
    'content-type': 'application/json',
    'x-vl-wait-ms': '50',
  };

  const sessionId = 'd'.repeat(32);

  // 2. Poll with outbox when ACL is NOT set (Default Deny)
  const msg1Id = '1'.repeat(32);
  const poll1 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 0, {
      outbox: [{ id: msg1Id, to: `${ownerId}:Dev`, text: 'first attempt' }],
    })),
  });
  assert.equal(poll1.headers.get('x-vl-outbox-cursor'), `${msg1Id}:rejected:acl-denied`);
  assert.equal(deliveredMessages.length, 0, 'no message delivered on default deny');

  // 3. Set ACL via PUT /api/vl-nodes/:nodeId/acl
  const aclRes = await fetch(`${base}/api/vl-nodes/${nodeId}/acl`, {
    method: 'PUT',
    headers: ui,
    body: JSON.stringify({ allowCells: ['Dev'] }),
  });
  assert.equal(aclRes.status, 200);
  const aclBody = await json(aclRes);
  assert.deepEqual(aclBody.acl, { allowCells: ['Dev'] });

  // Verify GET /api/vl-nodes/:nodeId/acl
  const getAclRes = await fetch(`${base}/api/vl-nodes/${nodeId}/acl`, { headers: ui });
  assert.equal(getAclRes.status, 200);
  assert.deepEqual((await json(getAclRes)).acl, { allowCells: ['Dev'] });

  // 4. Poll sending to cell outside ACL (SysAdmin) -> rejected:acl-denied
  const msg2Id = '2'.repeat(32);
  const poll2 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 1, {
      outbox: [{ id: msg2Id, to: `${ownerId}:SysAdmin`, text: 'to sysadmin' }],
    })),
  });
  assert.equal(poll2.headers.get('x-vl-outbox-cursor'), `${msg2Id}:rejected:acl-denied`);
  assert.equal(deliveredMessages.length, 0);

  // 5. Poll sending to allowed cell (Dev) -> delivered!
  // Include payload `from: "Impersonated"`: must be IGNORED!
  const msg3Id = '3'.repeat(32);
  const poll3 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 2, {
      outbox: [{ id: msg3Id, to: `${ownerId}:Dev`, text: 'hello from Kobo', from: 'FakeSender' }],
    })),
  });
  assert.equal(poll3.headers.get('x-vl-outbox-cursor'), `${msg3Id}:submitted`);
  assert.equal(deliveredMessages.length, 1);
  assert.equal(deliveredMessages[0].session, 'cloud-Dev');
  const expectedSender = `VL-${nodeId.slice(0, 8)}@${ownerId.slice(0, 8)}`;
  assert.equal(
    deliveredMessages[0].text,
    `[NexusCrew message ${msg3Id} from ${expectedSender}]\nhello from Kobo\n[End NexusCrew message]`
  );

  // 6. Remote destination rejected
  const msg4Id = '4'.repeat(32);
  const remoteOwner = 'f'.repeat(32);
  const poll4 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 3, {
      outbox: [{ id: msg4Id, to: `${remoteOwner}:Dev`, text: 'cross node' }],
    })),
  });
  assert.equal(poll4.headers.get('x-vl-outbox-cursor'), `${msg4Id}:rejected:remote-unsupported`);

  // 7. Events and Outbox in the SAME poll
  const msg5Id = '5'.repeat(32);
  const poll5 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 4, {
      events: [{ seq: 10, kind: 'text', text: 'turn thinking' }],
      outbox: [{ id: msg5Id, to: `${ownerId}:Dev`, text: 'outbox with events' }],
    })),
  });
  assert.equal(poll5.headers.get('x-vl-events-cursor'), '10');
  assert.equal(poll5.headers.get('x-vl-outbox-cursor'), `${msg5Id}:submitted`);

  // 8. Inactive cell rejected:target-not-active
  await fetch(`${base}/api/vl-nodes/${nodeId}/acl`, {
    method: 'PUT',
    headers: ui,
    body: JSON.stringify({ allowCells: ['Dev', 'InactiveCell'] }),
  });
  const msg6Id = '6'.repeat(32);
  const poll6 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 5, {
      outbox: [{ id: msg6Id, to: `${ownerId}:InactiveCell`, text: 'wake up' }],
    })),
  });
  assert.equal(poll6.headers.get('x-vl-outbox-cursor'), `${msg6Id}:rejected:target-not-active`);

  // 9. Oversize text rejected:oversized
  const msg7Id = '7'.repeat(32);
  const poll7 = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 6, {
      outbox: [{ id: msg7Id, to: `${ownerId}:Dev`, text: 'z'.repeat(2049) }],
    })),
  });
  assert.equal(poll7.headers.get('x-vl-outbox-cursor'), `${msg7Id}:rejected:oversized`);

  // 10. Rate limiting at HTTP level (consume up to 6 messages in the minute, 7th is rate-limited)
  // Already consumed 3 in this minute (msg3, msg5, msg6)
  for (let i = 8; i <= 10; i++) {
    const id = String(i).padStart(32, '0');
    const p = await fetch(`${base}/vl-node/v1/poll`, {
      method: 'POST',
      headers: nodeHeaders,
      body: JSON.stringify(heartbeat(nodeId, sessionId, i, {
        outbox: [{ id, to: `${ownerId}:Dev`, text: `burst ${i}` }],
      })),
    });
    assert.equal(p.headers.get('x-vl-outbox-cursor'), `${id}:submitted`);
  }
  // 7th message in the minute:
  const msgRateLimited = 'f'.repeat(32);
  const pollRateLimited = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 11, {
      outbox: [{ id: msgRateLimited, to: `${ownerId}:Dev`, text: 'should rate limit' }],
    })),
  });
  assert.equal(pollRateLimited.headers.get('x-vl-outbox-cursor'), `${msgRateLimited}:rejected:rate-limited`);

  // 11. Body limit 24kb: payload around 21kb succeeds (above 20kb legacy limit)
  const pollLarge = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: nodeHeaders,
    body: JSON.stringify(heartbeat(nodeId, sessionId, 13, {
      events: [{ seq: 11, kind: 'text', text: 'x'.repeat(4000) }],
      detail: 'y'.repeat(16000), // creates total body > 20kb
    })),
  });
  assert.notEqual(pollLarge.status, 413, 'payload between 20kb and 24kb must not be rejected with 413');
});
