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
const urlmod = require('../lib/cli/url.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const DEV = 'ab'.repeat(16);

test('buildUrl: il deviceId viaggia nel fragment accanto al token, solo se valido', () => {
  assert.equal(urlmod.buildUrl(41820, 'T0K', { withToken: true }), 'http://127.0.0.1:41820/#token=T0K');
  assert.equal(urlmod.buildUrl(41820, 'T0K', { withToken: true, deviceId: DEV }), `http://127.0.0.1:41820/#token=T0K&device=${DEV}`);
  assert.equal(urlmod.buildUrl(41820, 'T0K', { withToken: true, deviceId: 'nope' }), 'http://127.0.0.1:41820/#token=T0K');
  assert.equal(urlmod.buildUrl(41820, null, { withToken: false, deviceId: DEV }), 'http://127.0.0.1:41820/', 'mai un id senza token');
});

async function up(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-show-dev-'));
  const configDir = path.join(home, '.nexuscrew');
  const tokenPath = path.join(configDir, 'token');
  const port = await freePort();
  let runtime; let openedUrl = '';
  const result = await smartUp({
    home, configDir, configPath: path.join(configDir, 'config.json'), tokenPath, port, platform: 'termux', tmuxOk: true,
    installPath: path.join(home, '.termux', 'boot', 'nexuscrew.sh'),
    fleetInstallPath: path.join(home, '.termux', 'boot', 'nexuscrew-fleet.sh'),
    execImpl: () => '', portAvailableImpl: async () => true,
    runInitImpl: (o) => runInit(o),
    startPortableImpl: () => {
      runtime = createServer({ home, configDir, configPath: path.join(configDir, 'config.json'), tokenPath, port, filesRoot: path.join(home, 'NexusFiles') });
      runtime.server.listen(port, '127.0.0.1');
      return { started: true };
    },
    openImpl: (u) => { openedUrl = u; return true; },
    ...extra,
  });
  t.after(() => { try { runtime?.server.close(); } catch (_) {} try { runtime?.watcher.close(); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); });
  return { result, openedUrl, port, token: fs.readFileSync(tokenPath, 'utf8').trim() };
}

test('show/avvio: il link aperto porta un deviceId emesso dal nodo, valido per /api/prefs', async (t) => {
  const { openedUrl, port, token } = await up(t);
  const m = openedUrl.match(/#token=([^&]+)&device=([a-f0-9]{32})$/);
  assert.ok(m, openedUrl.replace(token, '<token>'));
  assert.equal(m[1], token);
  const r = await fetch(`http://127.0.0.1:${port}/api/prefs`, { headers: { authorization: `Bearer ${token}`, 'x-nc-device': m[2] } });
  assert.equal(r.status, 200);
});

test('show/avvio: se il nodo non emette l\'id il link resta quello di sempre e show non fallisce', async (t) => {
  const { openedUrl, token } = await up(t, { deviceIdImpl: async () => { throw new Error('timeout'); } });
  assert.ok(openedUrl.endsWith(`#token=${token}`));
  assert.ok(!openedUrl.includes('device='));
});
