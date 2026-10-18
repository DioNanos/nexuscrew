'use strict';
// tests/tmux-empty-server.test.js — NexusCrew starts tmux with
// `set -s exit-empty off` (the server stays alive with no sessions). In that
// state `list-panes -a` answers "no current target" (NOT "no server
// running"), and fleet polling used to discard the node as an error: the node
// would drop out of the fleet whenever its last session closed. The test uses
// the shared test-server factory (dedicated socket, -f /dev/null, closed by
// PID): never the fleet's tmux server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listPanes, listFleetPanes } = require('../lib/tmux/list.js');
const { avviaTmuxTest } = require('./tmux-test-server.js');

test('list-panes su un server vivo e vuoto risponde «no current target»', async (t) => {
  // La sessione di avvio e' la 'dummy' del caso: il server nasce, poi il test
  // lo svuota come un nodo appena riavviato.
  const server = await avviaTmuxTest({ primaSessione: 'dummy' });
  t.after(() => server.chiudi());
  const tmux = (args) => server.run(args);
  await tmux(['set-option', '-s', 'exit-empty', 'off']);
  await tmux(['kill-session', '-t', 'dummy']);
  // Now the server is alive and empty, as on a node right after a restart.
  await assert.doesNotReject(tmux(['list-sessions', '-F', '#{session_name}']),
    'il server resta vivo a zero sessioni (exit-empty off)');
  const probe = await tmux(['list-panes', '-a', '-F', '#{pane_id}']).then(
    () => 'OK', (error) => String(error.stderr || error.message));
  assert.match(probe, /no current target/i,
    `list-panes -a su server vivo e vuoto: ${probe}`);
});

test('listPanes/listFleetPanes risolvono con una lista vuota (non reject)', async (t) => {
  const server = await avviaTmuxTest({ primaSessione: 'dummy' });
  t.after(() => server.chiudi());
  const tmux = (args) => server.run(args);
  await tmux(['set-option', '-s', 'exit-empty', 'off']);
  await tmux(['kill-session', '-t', 'dummy']);
  // Un wrapper che instrada le letture del fleet sul socket PRIVATO (stesso
  // socket del server dell'helper: tmpdir e -f /dev/null fissati dallo script).
  const wrapper = server.wrapper();
  await assert.doesNotReject(listPanes(wrapper),
    'listPanes risolve con una lista vuota (non reject)');
  await assert.doesNotReject(listFleetPanes(wrapper),
    'listFleetPanes risolve con una lista vuota (non reject)');
  assert.equal(await listPanes(wrapper), '');
  assert.equal(await listFleetPanes(wrapper), '');
});
