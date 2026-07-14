const { test } = require('node:test');
const assert = require('node:assert');
const { parseSessions } = require('../lib/tmux/list.js');

test('parseSessions maps tab-separated tmux output', () => {
  const raw = 'claude_dev\t1\t3\t1718380800\t1751990000\tclaude\t\nidle_box\t0\t1\t1718384400\t1718390000\tbash\ttechnical\n';
  const out = parseSessions(raw);
  assert.deepStrictEqual(out, [
    { name: 'claude_dev', attached: true, windows: 3, created: 1718380800, activity: 1751990000, cmd: 'claude', technical: false },
    { name: 'idle_box', attached: false, windows: 1, created: 1718384400, activity: 1718390000, cmd: 'bash', technical: true },
  ]);
  assert.equal(out[0].activity, 1751990000);
  assert.equal(out[0].cmd, 'claude');
});

test('parseSessions returns [] on empty', () => {
  assert.deepStrictEqual(parseSessions(''), []);
});

test('parseSessions hides transient zero-window sessions', () => {
  const raw = 'cloud-phantom\t0\t0\t1718380800\t1718380801\t\nreal\t0\t1\t1718380800\t1718380801\tbash\n';
  assert.deepStrictEqual(parseSessions(raw).map((row) => row.name), ['real']);
});
