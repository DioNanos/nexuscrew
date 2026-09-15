const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { allowedByClass, classifyResource, CLASSES } = require('../lib/proxy/resource-acl.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'federation.js'), 'utf8');

// Every literal a federated resource is compared against in the allowlist.
function literalResources() {
  const out = new Set();
  const re = /resource === '([^']+)'/g;
  let m;
  while ((m = re.exec(SOURCE)) !== null) out.add(m[1]);
  return [...out];
}

// Routes whose match is a pattern rather than an equality: the concrete shapes
// the allowlist accepts, frozen here on purpose.
const PATTERN_RESOURCES = [
  ['/sessions/cell-a', 'DELETE'],
  ['/sessions/cell-a/visibility', 'PATCH'],
  ['/vl-nodes/0123456789abcdef0123456789abcdef/commands', 'POST'],
  ['/vl-nodes/0123456789abcdef0123456789abcdef/events', 'GET'],
  ['/vl-nodes/0123456789abcdef0123456789abcdef', 'DELETE'],
  ['/decks/some-deck', 'PUT'],
  ['/panel/cell-a', 'GET'],
  ['/panel/cell-a/assets/app.js', 'GET'],
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

test('every resource the federation allowlist accepts is classified', () => {
  const missing = [];
  for (const resource of literalResources()) {
    if (!METHODS.some((method) => classifyResource(resource, method))) missing.push(resource);
  }
  assert.deepStrictEqual(missing, [], `risorse in allowlist senza classe: ${missing.join(', ')}`);
});

test('the pattern routes are classified too', () => {
  for (const [resource, method] of PATTERN_RESOURCES) {
    assert.ok(classifyResource(resource, method), `${resource} ${method} non classificata`);
  }
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
  for (const [resource, method] of PATTERN_RESOURCES) {
    assert.strictEqual(allowedByClass(classifyResource(resource, method), null), true, `${resource} ${method}`);
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
