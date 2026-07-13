'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('official harness uses a private tmux socket and drops inherited tmux identity', () => {
  assert.ok(process.env.NEXUSCREW_TEST_HOME_ROOT);
  assert.ok(process.env.TMUX_TMPDIR);
  const root = path.resolve(process.env.NEXUSCREW_TEST_HOME_ROOT);
  const tmuxRoot = path.resolve(process.env.TMUX_TMPDIR);
  assert.ok(root && tmuxRoot.startsWith(`${root}${path.sep}`), `tmux socket is not under test root: ${tmuxRoot}`);
  assert.match(path.basename(tmuxRoot), /^pid-\d+$/, 'every test worker needs its own tmux socket directory');
  assert.equal(process.env.TMUX, undefined);
  assert.equal(process.env.TMUX_PANE, undefined);
});
