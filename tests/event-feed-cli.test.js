'use strict';
// tests/event-feed-cli.test.js — the CLI surface of the event feed:
// `nodes edit --events-receive on|off` and the doctor/nodes-show feed section
// (kill-switch, revision, grants, scope, cursor, last failure, counters).
// Read-only everywhere: no secrets, no runtime file reads from the CLI.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch } = require('../lib/cli/commands.js');
const cmds = require('../lib/nodes/commands.js');
const nodesCmds = require('../lib/nodes/commands.js');
const store = require('../lib/nodes/store.js');

function nodeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfeedcli-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  store.initStore(path.join(home, '.nexuscrew', 'nodes.json'));
  return home;
}
const nodesPathFor = (home) => path.join(home, '.nexuscrew', 'nodes.json');

test('nodes edit --events-receive on|off imposta la scelta locale di ricezione', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'p', ssh: 'user@peer', nodeId: 'b'.repeat(32), keygen: () => 'ssh-ed25519 AAAAFAKEKEY k' });
  const r1 = await dispatch(['nodes', 'edit', 'p', '--events-receive', 'on'], { home, log: () => {} });
  assert.equal(r1.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].eventsReceive, true);
  const r2 = await dispatch(['nodes', 'edit', 'p', '--events-receive', 'off'], { home, log: () => {} });
  assert.equal(r2.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].eventsReceive, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('un valore non on|off è rifiutato con esito esplicito', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'p', ssh: 'user@peer', nodeId: 'b'.repeat(32), keygen: () => 'ssh-ed25519 AAAAFAKEKEY k' });
  const r = await dispatch(['nodes', 'edit', 'p', '--events-receive', 'banana'], { home, log: () => {} });
  assert.equal(r.code, 1);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].eventsReceive, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('feedLinesFor prints kill-switch, revision, grants, scope, cursor and counters', () => {
  const diag = {
    ok: true,
    body: { enabled: true, peers: [{
      nodeId: 'd'.repeat(32), name: 'peer', accessLabel: 'user', accessRevision: 3,
      grants: { eventsAccess: true, nodeEventsAccess: true, cellVisibility: 'selected', cells: ['dev'], configured: true },
      feed: { lastCursor: '1:7', streams: 1, lastDropReason: null, lastRejectReason: null,
        counters: { delivered: 5, dropped: 1, replayed: 3, rejected: 0 } },
    }] },
  };
  const lines = nodesCmds.feedLinesFor(diag, 'd'.repeat(32));
  const text = lines.join('\n');
  assert.ok(lines.some((l) => l.includes('kill-switch')), 'the kill-switch line exists');
  assert.ok(text.includes('revision 3'));
  assert.ok(text.includes('events=on'));
  assert.ok(text.includes('scope celle selected'));
  assert.ok(text.includes('cursore 1:7'));
  assert.ok(text.includes('ultimo mancato: none'));
  assert.ok(text.includes('delivered 5'));
});

test('an unreachable local server is DECLARED, never reported as zero deliveries', () => {
  const lines = nodesCmds.feedLinesFor({ ok: false, reason: 'unreachable' }, 'x');
  assert.ok(lines[0].includes('non risponde'));
  const linesNoPeer = nodesCmds.feedLinesFor({ ok: true, body: { enabled: true, peers: [] } }, 'x');
  assert.ok(linesNoPeer[0].includes('nessuna vista'));
});
