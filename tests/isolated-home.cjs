'use strict';

// Loaded by the Node test runner and by every isolated test worker before the
// test module.  A unique HOME per process prevents a test that forgets one
// explicit path from reading or mutating the operator's real NexusCrew state.
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.NEXUSCREW_TEST_HOME_ROOT;
if (!root) throw new Error('NEXUSCREW_TEST_HOME_ROOT is required by the test harness');

const home = path.join(root, `pid-${process.pid}`);
const configHome = path.join(home, '.config');
fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
const tmuxRoot = process.env.NEXUSCREW_TEST_TMUX_ROOT || path.join(root, 'tmux');
fs.mkdirSync(tmuxRoot, { recursive: true, mode: 0o700 });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = configHome;
process.env.NEXUSCREW_CONFIG_FILE = path.join(home, '.nexuscrew', 'config.json');
process.env.NEXUSCREW_AUTO_UPDATE = '0';
process.env.TMUX_TMPDIR = tmuxRoot;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
