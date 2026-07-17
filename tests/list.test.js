const { test } = require('node:test');
const assert = require('node:assert');
const { FMT, parsePaneTitle, parseSessions, isNoTmuxServerError } = require('../lib/tmux/list.js');

test('parseSessions maps tab-separated tmux output', () => {
  const raw = 'claude_dev\t1\t3\t1718380800\t1751990000\tclaude\t\t⠐ Implement activity UI\nidle_box\t0\t1\t1718384400\t1718390000\tbash\ttechnical\tDev\n';
  const out = parseSessions(raw);
  assert.deepStrictEqual(out, [
    {
      name: 'claude_dev', attached: true, windows: 3, created: 1718380800,
      activity: 1751990000, cmd: 'claude', technical: false,
      paneTitle: '⠐ Implement activity UI', working: true, status: 'Implement activity UI',
    },
    {
      name: 'idle_box', attached: false, windows: 1, created: 1718384400,
      activity: 1718390000, cmd: 'bash', technical: true,
      paneTitle: 'Dev', working: false, status: '',
    },
  ]);
  assert.equal(out[0].activity, 1751990000);
  assert.equal(out[0].cmd, 'claude');
});

test('parsePaneTitle recognizes braille work spinners and sanitizes the one-line status', () => {
  assert.deepStrictEqual(parsePaneTitle('⠼ Audit mobile and desktop'), {
    paneTitle: '⠼ Audit mobile and desktop', working: true, status: 'Audit mobile and desktop',
  });
  assert.deepStrictEqual(parsePaneTitle('⠙\tFix\u0007 status line'), {
    paneTitle: '⠙ Fix status line', working: true, status: 'Fix status line',
  });
  assert.deepStrictEqual(parsePaneTitle('Dev'), {
    paneTitle: 'Dev', working: false, status: '',
  });
  assert.deepStrictEqual(parsePaneTitle('✳ Bootstrap Claude Auditor'), {
    paneTitle: '✳ Bootstrap Claude Auditor', working: false, status: '',
  }, 'Claude idle glyph is not a working spinner');
  assert.ok(FMT.endsWith('#{pane_title}'), 'tmux list format includes the terminal title signal');
});

test('parseSessions returns [] on empty', () => {
  assert.deepStrictEqual(parseSessions(''), []);
});

test('parseSessions hides transient zero-window sessions', () => {
  const raw = 'cloud-phantom\t0\t0\t1718380800\t1718380801\t\nreal\t0\t1\t1718380800\t1718380801\tbash\n';
  assert.deepStrictEqual(parseSessions(raw).map((row) => row.name), ['real']);
});

test('expected no-tmux-server signatures include the macOS missing socket', () => {
  assert.equal(isNoTmuxServerError('no server running on /tmp/tmux-1000/default'), true);
  assert.equal(isNoTmuxServerError('error connecting to /private/tmp/tmux-501/default (No such file or directory)'), true);
  assert.equal(isNoTmuxServerError('error connecting to /tmp/tmux-1000/default (Connection refused)'), true);
  assert.equal(isNoTmuxServerError('permission denied while reading tmux config'), false);
});
