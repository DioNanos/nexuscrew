'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const store = require('../lib/nodes/store.js');

const fixture = path.join(__dirname, 'fixtures', 'isolated-nexus-server.js');
const CLIENT_ID = 'b'.repeat(32);
const HUB_ID = 'a'.repeat(32);
const VIEWER_ID = 'c'.repeat(32);

function writeToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
}

function runtimePaths(root, name) {
  const home = path.join(root, name);
  const state = path.join(home, '.nexuscrew');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const configPath = path.join(state, 'config.json');
  const nodesPath = path.join(state, 'nodes.json');
  const tokenPath = path.join(state, 'token');
  fs.writeFileSync(configPath, '{"bind":"127.0.0.1","port":0,"fleetEnabled":false,"autoUpdate":false}\n', { mode: 0o600 });
  return { home, state, configPath, nodesPath, tokenPath };
}

function startRuntime(paths, port = 0) {
  const spec = { ...paths, port };
  const env = {
    PATH: process.env.PATH,
    HOME: paths.home,
    NEXUSCREW_CONFIG_FILE: paths.configPath,
    NEXUSCREW_TOKEN_FILE: paths.tokenPath,
    NEXUSCREW_AUTO_UPDATE: '0',
    NEXUSCREW_FLEET: '0',
    NEXUSCREW_FIELD_SPEC: JSON.stringify(spec),
  };
  return new Promise((resolve, reject) => {
    const child = fork(fixture, [], {
      env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`isolated runtime startup timeout: ${stderr}`));
    }, 10000);
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`isolated runtime exited ${code}: ${stderr}`));
    };
    child.once('exit', onExit);
    child.on('message', (message) => {
      if (message?.type === 'error') {
        clearTimeout(timer); reject(new Error(message.message));
      }
      if (message?.type === 'ready') {
        clearTimeout(timer); child.off('exit', onExit);
        resolve({ child, port: message.port, paths, events: [] });
      }
    });
    child.on('message', (message) => {
      if (message?.type === 'forward') child.__fieldEvents = [...(child.__fieldEvents || []), message];
    });
  });
}

function stopRuntime(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { runtime.child.kill('SIGKILL'); } catch (_) {}
    }, 3000);
    runtime.child.once('exit', () => { clearTimeout(timer); resolve(); });
    runtime.child.kill('SIGTERM');
  });
}

async function api(runtime, token, endpoint, opts = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${endpoint}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const outbound = ({ name, localPort, nodeId, token, acceptToken, reversePort }) => ({
  name, ssh: name, remotePort: localPort, localPort,
  direction: 'outbound', transport: 'auto', autostart: false,
  shared: false, visibility: 'network', nodeId, token, acceptToken,
  ...(reversePort ? { reversePort } : {}),
});

const inbound = ({ name, localPort, nodeId, token, acceptToken, label }) => ({
  name, remotePort: localPort, localPort,
  direction: 'inbound', transport: 'inbound', autostart: true,
  shared: false, visibility: 'network', nodeId, token, acceptToken, label,
});

test('isolated real runtimes distinguish offline retention from explicit Share revocation', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-field-'));
  const clientPaths = runtimePaths(root, 'client');
  const hubPaths = runtimePaths(root, 'hub');
  const viewerPaths = runtimePaths(root, 'viewer');
  writeToken(clientPaths.tokenPath, 'client-api');
  writeToken(hubPaths.tokenPath, 'hub-api');
  writeToken(viewerPaths.tokenPath, 'viewer-api');
  store.atomicWriteStore(clientPaths.nodesPath, store.emptyStore(CLIENT_ID));
  store.atomicWriteStore(hubPaths.nodesPath, store.emptyStore(HUB_ID));
  store.atomicWriteStore(viewerPaths.nodesPath, store.emptyStore(VIEWER_ID));

  const runtimes = [];
  t.after(async () => {
    for (const runtime of [...runtimes].reverse()) await stopRuntime(runtime);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const client = await startRuntime(clientPaths); runtimes.push(client);
  let hubStore = store.loadStoreStrict(hubPaths.nodesPath);
  hubStore = store.addNode(hubStore, inbound({
    name: 'pixel', label: 'Pixel', localPort: client.port, nodeId: CLIENT_ID,
    token: 'hub-to-client', acceptToken: 'client-to-hub',
  }));
  hubStore = store.addNode(hubStore, inbound({
    name: 'viewer', label: 'Viewer', localPort: 1, nodeId: VIEWER_ID,
    token: 'hub-to-viewer', acceptToken: 'viewer-to-hub',
  }));
  store.atomicWriteStore(hubPaths.nodesPath, hubStore);
  let hub = await startRuntime(hubPaths); runtimes.push(hub);

  let clientStore = store.loadStoreStrict(clientPaths.nodesPath);
  clientStore = store.addNode(clientStore, outbound({
    name: 'hub', localPort: hub.port, reversePort: client.port, nodeId: HUB_ID,
    token: 'client-to-hub', acceptToken: 'hub-to-client',
  }));
  store.atomicWriteStore(clientPaths.nodesPath, clientStore);

  let viewerStore = store.loadStoreStrict(viewerPaths.nodesPath);
  viewerStore = store.addNode(viewerStore, outbound({
    name: 'hub', localPort: hub.port, nodeId: HUB_ID,
    token: 'viewer-to-hub', acceptToken: 'hub-to-viewer',
  }));
  store.atomicWriteStore(viewerPaths.nodesPath, viewerStore);
  const viewer = await startRuntime(viewerPaths); runtimes.push(viewer);

  const setShare = (shared) => api(client, 'client-api', '/api/settings/nodes/hub/share', {
    method: 'PATCH', body: JSON.stringify({ shared }),
  });
  let changed = await setShare(true);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.shared, true);

  let topology = await api(viewer, 'viewer-api', '/api/topology');
  let pixel = topology.body.nodes.find((node) => node.route?.join('/') === 'hub/pixel');
  assert.equal(pixel?.stale, false, 'shared Pixel is operationally visible');

  await stopRuntime(hub);
  runtimes.splice(runtimes.indexOf(hub), 1);
  topology = await api(viewer, 'viewer-api', '/api/topology');
  pixel = topology.body.nodes.find((node) => node.route?.join('/') === 'hub/pixel');
  assert.equal(pixel?.stale, true, 'transport loss retains the last authorized Pixel as stale');

  hub = await startRuntime(hubPaths, hub.port); runtimes.push(hub);
  topology = await api(viewer, 'viewer-api', '/api/topology');
  pixel = topology.body.nodes.find((node) => node.route?.join('/') === 'hub/pixel');
  assert.equal(pixel?.stale, false, 'authoritative recovery restores fresh visibility before revocation');

  changed = await setShare(false);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.revoked, true);
  topology = await api(viewer, 'viewer-api', '/api/topology');
  assert.equal(topology.body.nodes.some((node) => node.route?.join('/') === 'hub/pixel'), false,
    'explicit OFF is an authoritative withdrawal, not an offline owner');
  const hubInventory = await api(hub, 'hub-api', '/api/nodes');
  const privatePixel = hubInventory.body.nodes.find((node) => node.name === 'pixel');
  assert.equal(privatePixel?.shared, false, 'private pairing remains in administrative inventory');

  changed = await setShare(true);
  assert.equal(changed.response.status, 200);
  topology = await api(viewer, 'viewer-api', '/api/topology');
  pixel = topology.body.nodes.find((node) => node.route?.join('/') === 'hub/pixel');
  assert.equal(pixel?.stale, false, 'authorized re-share returns as fresh topology');

  changed = await setShare(false);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.revoked, true, 'fixture exits in the private state');
});
