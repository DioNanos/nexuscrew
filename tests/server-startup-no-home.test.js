'use strict';
// A production install starts the server with no explicit cfg.home: every
// other path in createServer falls back to os.homedir() (server.js). The
// owner ASK scope must follow the same recipe, or createServer crashes with
// ERR_INVALID_ARG_TYPE before the socket ever listens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

test('createServer starts and serves with no explicit home, like a production install', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-startup-no-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() follows HOME on Linux
  fs.mkdirSync(path.join(home, '.nexuscrew'));
  const runtime = createServer({
    configDir: path.join(home, '.nexuscrew'),
    nodesPath: path.join(home, '.nexuscrew', 'nodes.json'),
    configPath: path.join(home, '.nexuscrew', 'config.json'),
    tokenPath: path.join(home, '.nexuscrew', 'token'),
    filesRoot: path.join(home, 'files'), port: 0,
    // NO home, NO fleetDefsPath, NO fleetEnabled: exactly what a real
    // production install passes.
    sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); },
      serviceInstallPath: path.join(home, 'service'), keygen: () => 'ssh-ed25519 AAAAFIXTURE demo',
      spawnImpl: () => ({ pid: 4200000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  t.after(async () => {
    process.env.HOME = previousHome;
    runtime.server.closeAllConnections();
    await new Promise((resolve) => runtime.server.close(resolve));
    runtime.watcher.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const port = runtime.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${runtime.token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body && Array.isArray(body.sessions), 'sessions must answer a real payload');
});
