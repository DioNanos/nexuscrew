'use strict';
// tests/tmux-empty-server.test.js — NexusCrew starts tmux with
// `set -s exit-empty off` (the server stays alive with no sessions). In that
// state `list-panes -a` answers "no current target" (NOT "no server
// running"), and fleet polling used to discard the node as an error: the node
// would drop out of the fleet whenever its last session closed. The test uses
// a PRIVATE socket (-L) with an ephemeral server: never the fleet's tmux
// server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { chmod, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listPanes, listFleetPanes } = require('../lib/tmux/list.js');

const SOCKET = `nc-0963-empty-${process.pid}`;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCKET, ...args], (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || err.message);
        reject(err); return;
      }
      resolve(stdout);
    });
  });
}

test('list-panes su un server vivo e vuoto risponde «no current target»', async (t) => {
  await tmux(['new-session', '-d', '-s', 'dummy']);
  await tmux(['set-option', '-s', 'exit-empty', 'off']);
  await tmux(['kill-session', '-t', 'dummy']);
  t.after(() => tmux(['kill-server']).catch(() => {}));
  // Now the server is alive and empty, as on a node right after a restart.
  await assert.doesNotReject(tmux(['list-sessions', '-F', '#{session_name}']),
    'il server resta vivo a zero sessioni (exit-empty off)');
  const probe = await tmux(['list-panes', '-a', '-F', '#{pane_id}']).then(
    () => 'OK', (error) => String(error.stderr || error.message));
  assert.match(probe, /no current target/i,
    `list-panes -a su server vivo e vuoto: ${probe}`);
});

test('listPanes/listFleetPanes risolvono con una lista vuota (non reject)', async (t) => {
  await tmux(['new-session', '-d', '-s', 'dummy']);
  await tmux(['set-option', '-s', 'exit-empty', 'off']);
  await tmux(['kill-session', '-t', 'dummy']);
  t.after(() => tmux(['kill-server']).catch(() => {}));
  // Un wrapper che instrada le letture del fleet sul socket PRIVATO.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-0963-tmux-'));
  const wrapper = path.join(dir, 'tmux-socket');
  await writeFile(wrapper, `#!/bin/sh\nexec tmux -L ${SOCKET} "$@"\n`, { mode: 0o755 });
  await chmod(wrapper, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.doesNotReject(listPanes(wrapper),
    'listPanes risolve con una lista vuota (non reject)');
  await assert.doesNotReject(listFleetPanes(wrapper),
    'listFleetPanes risolve con una lista vuota (non reject)');
  assert.equal(await listPanes(wrapper), '');
  assert.equal(await listFleetPanes(wrapper), '');
});
