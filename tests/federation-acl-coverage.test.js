const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { allowedByClass, classifyResource, CLASSES } = require('../lib/proxy/resource-acl.js');
const { allowedResource } = require('../lib/proxy/federation.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'federation.js'), 'utf8');

// Every literal a federated resource is compared against in the allowlist.
function literalResources() {
  const out = new Set();
  const re = /resource === '([^']+)'/g;
  let m;
  while ((m = re.exec(SOURCE)) !== null) out.add(m[1]);
  return [...out];
}

// The fleet family: one entry per alternative the allowlist accepts.
const FLEET_READ = ['status', 'schema', 'definitions', 'credentials/status'];
const FLEET_WRITE = [
  'credentials/set', 'credentials/remove', 'up', 'down', 'restart', 'engine', 'boot',
  'define-engine', 'edit-engine', 'remove-engine', 'define-model', 'remove-model',
  'model-test', 'define-cell', 'edit-cell', 'remove-cell', 'restore-cells', 'restore-engines',
];

// One sample path per branch of the allowlist: the literals, plus an example for
// every alternative of the pattern branches (with a generic cell/node id). A
// branch nothing here represents is a branch nothing checks.
const CORPUS = [
  ...literalResources(),
  '/panel/cell-a',
  '/panel/cell-a/assets/app.js',
  '/sessions/cell-a',
  '/sessions/cell-a/visibility',
  '/vl-nodes/0123456789abcdef0123456789abcdef/commands',
  '/vl-nodes/0123456789abcdef0123456789abcdef/events',
  '/vl-nodes/0123456789abcdef0123456789abcdef',
  '/decks/some-deck',
  '/event-feed/cell-a',
  '/event-feed/asks/abc12345/answer',
  '/event-feed/asks/abc12345',
  '/event-feed/asks/abc12345/requests/0f8fad5b-d9cb-469f-a165-70867728950e',
  '/event-feed/node/0123456789abcdef0123456789abcdef',
  ...FLEET_READ.map((alt) => `/fleet/${alt}`),
  ...FLEET_WRITE.map((alt) => `/fleet/${alt}`),
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// The classes whose route is designed but not yet in the allowlist: the event
// feed and the asks arrive later on purpose, and the class has to exist already
// so F3.1 cannot serve them unclassified. They are the only ones allowed to be
// ahead of the allowlist.
// No class is ahead of the allowlist anymore: the federated ask routes
// closed the last gap. From here on, every class and the allowlist must stay
// aligned like every other resource.
const CLASSES_AHEAD_OF_ALLOWLIST = new Set([]);

test('every (resource, method) the allowlist accepts has a class', () => {
  const missing = [];
  for (const resource of CORPUS) {
    for (const method of METHODS) {
      if (allowedResource(resource, method) && !classifyResource(resource, method)) {
        missing.push(`${method} ${resource}`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], `allowlist senza classe: ${missing.join(', ')}`);
});

test('no class is broader than the allowlist', () => {
  const wider = [];
  for (const resource of CORPUS) {
    for (const method of METHODS) {
      const cls = classifyResource(resource, method);
      if (!cls || CLASSES_AHEAD_OF_ALLOWLIST.has(cls)) continue;
      if (!allowedResource(resource, method)) wider.push(`${method} ${resource} → ${cls}`);
    }
  }
  assert.deepStrictEqual(wider, [], `classi più larghe dell'allowlist: ${wider.join(', ')}`);
});

test('the corpus covers every literal the allowlist compares', () => {
  const missing = literalResources().filter((resource) => !CORPUS.includes(resource));
  assert.deepStrictEqual(missing, [], `letterali fuori dal corpus: ${missing.join(', ')}`);
});

test('the fleet family is classified exactly on the methods the allowlist accepts', () => {
  for (const alt of FLEET_READ) {
    assert.strictEqual(classifyResource(`/fleet/${alt}`, 'GET'), 'operator', `GET /fleet/${alt}`);
  }
  for (const alt of FLEET_WRITE) {
    assert.strictEqual(classifyResource(`/fleet/${alt}`, 'POST'), 'operator', `POST /fleet/${alt}`);
  }
  // ...and on the methods it does NOT accept there is no class at all.
  assert.strictEqual(classifyResource('/fleet/status', 'DELETE'), null);
  assert.strictEqual(classifyResource('/fleet/restart', 'GET'), null);
});

test('a class always demands at least one grant, or explicit visibility', () => {
  for (const [name, cls] of Object.entries(CLASSES)) {
    assert.ok(cls.grants.length > 0 || cls.needsVisibility === true, `classe ${name} senza gate`);
  }
});

test('an unclassified resource is denied for every peer, admin included', () => {
  const admin = {
    cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true, askReplyAccess: true,
    filesReadAccess: true, liveHostAccess: true, panelAccess: true, peerOperatorAccess: true,
  };
  assert.strictEqual(classifyResource('/something-new', 'GET'), null);
  assert.strictEqual(classifyResource('/something-new', 'POST'), null);
  assert.strictEqual(allowedByClass(null, admin), false);
  assert.strictEqual(allowedByClass('no-such-class', admin), false);
});

test('the user profile opens reading and closes acting', () => {
  const user = {
    cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true, askReplyAccess: false,
    filesReadAccess: true, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  };
  const allowed = [['/cells', 'GET'], ['/sessions', 'GET'], ['/files', 'GET'], ['/files/download', 'GET'], ['/event-feed', 'GET']];
  const denied = [
    ['/files', 'DELETE'], ['/files/upload', 'POST'], ['/sessions', 'POST'], ['/sessions/cell-a', 'DELETE'],
    ['/config', 'GET'], ['/fs/dirs', 'GET'], ['/cells/send', 'POST'], ['/decks', 'POST'], ['/decks/some-deck', 'DELETE'],
    ['/live-host', 'GET'], ['/live-host/designate', 'POST'], ['/live-host/bridge', 'POST'],
    ['/panel/cell-a', 'GET'], ['/vl-nodes/invite', 'POST'],
    ['/vl-nodes/0123456789abcdef0123456789abcdef/commands', 'POST'],
  ];
  for (const [resource, method] of allowed) {
    const cls = classifyResource(resource, method);
    assert.strictEqual(allowedByClass(cls, user), true, `${resource} ${method} dovrebbe essere concesso a user`);
  }
  for (const [resource, method] of denied) {
    const cls = classifyResource(resource, method);
    assert.strictEqual(allowedByClass(cls, user), false, `${resource} ${method} NON dovrebbe essere concesso a user`);
  }
});

test('a peer with no visible cell sees no inventory, and the owner is never limited', () => {
  const noCells = {
    cellVisibility: 'none', eventsAccess: true, nodeEventsAccess: true, askReplyAccess: false,
    filesReadAccess: true, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  };
  assert.strictEqual(allowedByClass('inventory', noCells), false);
  assert.strictEqual(allowedByClass('inventory', null), true);
  // The owner of this node is not limited by the peer gate, on any pair the
  // allowlist accepts.
  for (const resource of CORPUS) {
    for (const method of METHODS) {
      if (!allowedResource(resource, method)) continue;
      assert.strictEqual(allowedByClass(classifyResource(resource, method), null), true, `${method} ${resource}`);
    }
  }
});

// --- the gate runs before the dispatch, on real federated traffic -------------

const os = require('node:os');
const http = require('node:http');
const express = require('express');
const fed = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

function tokenStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-acl-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('c'.repeat(32));
  st = store.addNode(st, {
    name: 'hub', direction: 'outbound', remotePort: 2222, localPort: 2223,
    ssh: 'user@hub', token: 'b'.repeat(32), shared: true,
  });
  store.atomicWriteStore(nodesPath, st);
  return { dir, nodesPath };
}

// The same handler the node mounts for federated traffic. The local API behind
// the last hop answers everything, so a refusal can only come from the gate in
// front of it; a peer request without a visited chain stops at the next check,
// which is enough to see that the gate let it through.
async function bootFederated(t, ingress) {
  const { dir, nodesPath } = tokenStore();
  const app = express();
  let serverRef = null;
  const selfPort = () => (serverRef && serverRef.address() ? serverRef.address().port : 0);
  app.get('/api/cells', (_req, res) => res.json({ ok: true }));
  app.use('/api/route', (req, res) => fed.routeHandler({
    nodesPath, localPort: selfPort, localCredential: () => 'owner-local-token',
    ingress, readonly: () => false, hopSecret: () => 'owner-hop-secret',
  })(req, res));
  const server = http.createServer(app);
  serverRef = server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

const USER_PEER = {
  nodeId: 'd'.repeat(32), cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true,
  askReplyAccess: false, filesReadAccess: true, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
};

const call = (base, resource, method = 'GET') => fetch(`${base}/api/route/hub/_${resource}`, { method });

test('a limited peer is refused on acting resources before the dispatch', async (t) => {
  const base = await bootFederated(t, { ...USER_PEER });
  for (const [resource, method, reason] of [
    ['/decks', 'POST', 'grant-required:operator'],
    ['/config', 'GET', 'grant-required:operator'],
    // The panel and live-hosting gates answer first with their own reason:
    // the class gate is the net, not a replacement for the specific ones.
    ['/live-host/designate', 'POST', 'live-host-not-granted'],
    ['/panel/cell-a', 'GET', 'panel-not-granted'],
  ]) {
    const res = await call(base, resource, method);
    assert.strictEqual(res.status, 403, `${resource} ${method}`);
    assert.strictEqual((await res.json()).reason, reason, `${resource} ${method}`);
  }
});

test('a resource its class allows is not blocked by the gate', async (t) => {
  const base = await bootFederated(t, { ...USER_PEER });
  const res = await call(base, '/cells', 'GET');
  const body = await res.json();
  assert.notStrictEqual(body.reason, 'grant-required:inventory');
  // It moved on to the next check (a peer request with no visited chain).
  assert.strictEqual(res.status, 409);
  assert.match(String(body.error), /cycle rejected/);
});

test('an unknown resource stays a 404, whatever the ingress', async (t) => {
  const base = await bootFederated(t, { ...USER_PEER });
  const res = await call(base, '/some-new-route', 'GET');
  assert.strictEqual(res.status, 404);
});

// --- the decision is re-read on every request --------------------------------

const net = require('node:net');

const ADMIN_PEER = {
  nodeId: 'e'.repeat(32), cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true,
  askReplyAccess: true, filesReadAccess: true, liveHostAccess: true, panelAccess: true, peerOperatorAccess: true,
};

// A raw WebSocket upgrade through the federated entry point: the reply is a
// status line, so this sees exactly what the upgrade gate decided.
function upgradeAttempt(port, resource) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /api/route/hub/_${resource} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n')) { socket.destroy(); resolve(buf.split('\r\n')[0]); }
    });
    socket.on('close', () => resolve(buf.split('\r\n')[0] || ''));
    socket.on('error', () => resolve(buf.split('\r\n')[0] || ''));
    setTimeout(() => { socket.destroy(); resolve(buf.split('\r\n')[0] || 'closed'); }, 1500).unref();
  });
}

test('a downgrade is effective on the very next request', async (t) => {
  const peerGrants = { ...ADMIN_PEER };
  const base = await bootFederated(t, peerGrants);
  const before = [];
  // `/decks` matters here: no specific gate of its own, so what it observes is
  // the class decision and nothing else.
  for (const [resource, method] of [['/decks', 'POST'], ['/live-host/designate', 'POST'], ['/panel/cell-a', 'GET']]) {
    const res = await call(base, resource, method);
    before.push(`${resource} ${res.status}`);
    assert.strictEqual(res.status, 409, `${resource} doveva passare i gate prima del downgrade`);
  }
  // The owner takes the peer down to the limited profile.
  Object.assign(peerGrants, {
    liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
    askReplyAccess: false,
  });
  const after = [];
  for (const [resource, method, reason] of [
    ['/decks', 'POST', 'grant-required:operator'],
    ['/live-host/designate', 'POST', 'live-host-not-granted'],
    ['/panel/cell-a', 'GET', 'panel-not-granted'],
  ]) {
    const res = await call(base, resource, method);
    const body = await res.json();
    after.push(`${resource} ${res.status}`);
    assert.strictEqual(res.status, 403, `${resource} doveva essere negata subito dopo il downgrade`);
    assert.strictEqual(body.reason, reason);
  }
  assert.ok(before.length === after.length);
});

test('an upgrade is an entry point too: a limited peer cannot open it', async (t) => {
  const base = await bootFederated(t, { ...USER_PEER });
  const port = Number(new URL(base).port);
  const line = await upgradeAttempt(port, '/ws');
  assert.match(line, / 403 /, `upgrade /ws con peer limitato: ${line}`);
  const notGranted = await upgradeAttempt(port, '/some-new-route');
  assert.match(notGranted, / 404 /, `upgrade su risorsa ignota: ${notGranted}`);
});

test('nexushost sees nothing of the owner, and the owner sees it only if it concedes', async (t) => {
  const NEXUSHOST_PEER = {
    nodeId: 'f'.repeat(32), cellVisibility: 'none', eventsAccess: false, nodeEventsAccess: false,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  };
  const owner = await bootFederated(t, { ...NEXUSHOST_PEER });
  // Only resources the federation allowlist already serves: the event feed is
  // classified but its route arrives with the feed itself.
  for (const [resource, method] of [['/cells', 'GET'], ['/files/download', 'GET'], ['/decks', 'POST'], ['/config', 'GET']]) {
    const res = await call(owner, resource, method);
    assert.strictEqual(res.status, 403, `${resource} non dovrebbe essere visibile a un nexushost`);
  }
  // The other direction is the peer's own concession, read on ITS gate: when it
  // grants the owner a limited vector, the inventory is no longer blocked.
  const conceding = await bootFederated(t, { ...USER_PEER });
  const res = await call(conceding, '/cells', 'GET');
  assert.strictEqual(res.status, 409);
});

// A full operator is not sent away with "resource-not-classified": the class
// exists (operator) and the request moves past the gate. What happens next is
// another check's business — only that reason must be gone.
test('an operator is not refused with resource-not-classified on the family that used to miss a class', async (t) => {
  const base = await bootFederated(t, { ...ADMIN_PEER });
  for (const [resource, method] of [
    ['/fleet/status', 'GET'],
    ['/diagnostics/logs', 'DELETE'],
    ['/audio/speak/status', 'POST'],
  ]) {
    const res = await call(base, resource, method);
    const body = await res.json().catch(() => ({}));
    assert.notStrictEqual(body.reason, 'resource-not-classified', `${method} ${resource}`);
  }
});
