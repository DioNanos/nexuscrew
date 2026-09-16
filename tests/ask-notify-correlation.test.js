'use strict';
// tests/ask-notify-correlation.test.js — the ask correlation, on the REAL path.
//
// An ask's alert must be able to open THAT ask, on the owner's side already and
// on the peer's side after the import. The correlation travels: ask creation ->
// emission -> source projection (producer) -> exported envelope -> subscriber
// -> push relay -> payload. Every link is exercised here from the real code:
// the ask is created through the real route of a real server, the envelope is
// the one the server really exported, and the import side is the real
// subscriber re-emission plus the real relay.
//
// The transport between the two nodes is the only thing faked (the envelope is
// handed over instead of being streamed), so what is proved is the correlation
// itself, not the federation wire.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const { createPushRelay, createPushDedup } = require('../lib/notify/push-relay.js');

const OWNER = 'c'.repeat(32);
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskcorr-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    sessionExistsSeam: () => true,
    pasteSeam: () => true,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, configDir });
  }));
}

function exportedNotify(configDir, askId) {
  const file = path.join(configDir, 'event-feed-history.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (parsed.entries || []).map((entry) => entry && entry.envelope).filter(Boolean);
  return list.find((e) => e.frame && e.frame.type === 'notify' && e.frame.askId === askId) || null;
}

test('la ask creata porta la sua correlazione fino al payload del push importato', async (t) => {
  const { base, token, configDir } = await boot(t);
  const session = tmuxSessionForCell('dev');
  const created = await fetch(`${base}/api/asks`, {
    method: 'POST', headers: H(token),
    body: JSON.stringify({ question: 'procedo?', options: ['si', 'no'], session }),
  });
  assert.equal(created.status, 201, 'la ask si crea dalla route reale');
  const { id } = await created.json();

  // 1) Il percorso REALE di creazione ha esportato un notify correlato alla ask.
  const envelope = exportedNotify(configDir, id);
  assert.ok(envelope, 'l evento esportato per la ask porta il suo askId');
  assert.equal(envelope.scope, 'cell');
  assert.equal(envelope.frame.askId, id);

  // 2) L'import lato peer: ri-emissione reale del subscriber + relay reale.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskcorrfeed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const alerts = [];
  const relay = createPushRelay({
    pushDedup: createPushDedup({ filePath: path.join(dir, 'push-dedup.json') }),
    send: async (p) => { alerts.push(p); return { sent: 1 }; },
  });
  const client = createEventFeedClient({
    eventsHub: { broadcast: (e) => { relay.considerImported(e); return 1; } },
  });
  assert.equal(client.reemit({ ...envelope, ownerId: OWNER, hop: 1 }), true);

  // 3) Il payload apre la STESSA ask: id presente e route con &ask=.
  assert.equal(alerts.length, 1, 'l avviso importato parte');
  assert.equal(alerts[0].askId, id);
  assert.match(String(alerts[0].url), new RegExp(`[?&#]ask=${id}(&|$)`));
  assert.match(String(alerts[0].url), /^\/#owner=/);
});
