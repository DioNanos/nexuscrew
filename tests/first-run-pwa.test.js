'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { smartUp } = require('../lib/cli/commands.js');
const { runInit } = require('../lib/cli/init.js');
const { createServer } = require('../lib/server.js');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('fresh install -> background orchestration -> authenticated PWA wizard reachable', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-first-run-'));
  const configDir = path.join(home, '.nexuscrew');
  const configPath = path.join(configDir, 'config.json');
  const tokenPath = path.join(configDir, 'token');
  const port = await freePort();
  let runtime;
  let openedUrl = '';

  const result = await smartUp({
    home, configDir, configPath, tokenPath, port, platform: 'termux', tmuxOk: true,
    installPath: path.join(home, '.termux', 'boot', 'nexuscrew.sh'),
    fleetInstallPath: path.join(home, '.termux', 'boot', 'nexuscrew-fleet.sh'),
    execImpl: () => '',
    portAvailableImpl: async () => true,
    runInitImpl: (opts) => runInit(opts),
    startPortableImpl: () => {
      runtime = createServer({
        home, configDir, configPath, tokenPath, port,
        filesRoot: path.join(home, 'NexusFiles'),
      });
      runtime.server.listen(port, '127.0.0.1');
      return { started: true };
    },
    openImpl: (url) => { openedUrl = url; return true; },
  });

  t.after(() => {
    try { runtime?.server.close(); } catch (_) {}
    try { runtime?.watcher.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.equal(result.running, true);
  assert.equal(result.opened, true);
  assert.match(openedUrl, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=`));
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.ok(token && openedUrl.endsWith(token));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).firstRun, true);
  const fleet = await fetch(`http://127.0.0.1:${port}/api/fleet/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(fleet.status, 200);
  const fleetStatus = await fleet.json();
  assert.equal(fleetStatus.available, true);
  assert.equal(fleetStatus.provider, 'builtin');
  assert.equal(fleetStatus.capabilities.includes('edit'), true);
});
