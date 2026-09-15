'use strict';
// The user service manager is per-UID, not per-HOME: `systemctl --user` and
// `launchctl` resolve the unit by NAME inside the namespace of the logged-in
// user. `nexuscrew init` writes the definition under the HOME it was given, so a
// run with a temporary HOME wrote a definition the manager never loads while the
// activation commands still hit the real manager and restarted the REAL service
// (measured twice on the live node during a smoke run).
//
// The guard decides ONCE, before the activation commands: if the manager already
// loads one of our definitions from a different path, activation is skipped and
// said out loud instead of touching production.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installService, generateLinux, generateMac, installPath } = require('../lib/cli/service.js');
const { runInit } = require('../lib/cli/init.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linuxCtx(home, over = {}) {
  return {
    repoRoot: '/home/user/nexuscrew',
    nodeBin: '/usr/bin/node',
    port: 41820,
    home,
    uid: 1000,
    ...over,
  };
}

// Fake service manager: answers the FragmentPath probe and records every command
// it is asked to run.
function systemdFake(fragmentPath) {
  const calls = [];
  const execImpl = (bin, args) => {
    calls.push([bin, args.join(' ')]);
    if (args.includes('--property=FragmentPath')) return fragmentPath;
    return '';
  };
  const ran = (verb) => calls.filter(([bin, line]) => bin === 'systemctl' && line.includes(`--user ${verb}`)).length;
  return { calls, execImpl, ran, probed: () => calls.filter(([, line]) => line.includes('--property=FragmentPath')).length };
}

test('installService linux: a manager that loads a different unit is never enabled or restarted', () => {
  const home = tmpDir('nc-n25-foreign-');
  const foreign = '/home/someone-else/.config/systemd/user/nexuscrew.service';
  const ctx = linuxCtx(home);
  const { execImpl, ran } = systemdFake(foreign);

  const result = installService('linux', generateLinux(ctx), ctx, { execImpl });

  assert.equal(result.written, true, 'the definition under the given HOME is still written');
  assert.equal(ran('restart'), 0, 'the real service must NOT be restarted');
  assert.equal(ran('enable'), 0, 'the real unit must NOT be enabled');
  assert.equal(ran('daemon-reload'), 0, 'the real manager must not even be reloaded');
  assert.deepEqual(result.failures, [], 'a deliberate skip is not an activation failure');
  assert.equal(result.activation.outcome, 'skipped-foreign-manager');
  assert.equal(result.activation.managerPath, foreign);
  assert.match(result.activation.warning, /unit installed at /);
  assert.ok(result.activation.warning.includes(home), 'the warning names the path we wrote');
  assert.ok(result.activation.warning.includes(foreign), 'the warning names the path the manager loads');
  assert.match(result.activation.warning, /activation skipped/);
  assert.match(result.activation.warning, /--no-activate/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installService linux: a manager that loads the unit just written activates as before', () => {
  const home = tmpDir('nc-n25-same-');
  const ctx = linuxCtx(home);
  const target = installPath('linux', home);
  const { execImpl, ran } = systemdFake(target);

  const result = installService('linux', generateLinux(ctx), ctx, { execImpl });

  assert.equal(result.activation.outcome, 'activated');
  assert.equal(result.activation.warning, null);
  assert.equal(ran('daemon-reload'), 1);
  assert.equal(ran('enable'), 1);
  assert.equal(ran('restart'), 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installService linux: activate false writes the definition and skips activation unconditionally', () => {
  const home = tmpDir('nc-n25-flag-');
  const ctx = linuxCtx(home);
  const { execImpl, calls } = systemdFake(installPath('linux', home));

  const result = installService('linux', generateLinux(ctx), ctx, { execImpl, activate: false });

  assert.equal(result.written, true);
  assert.equal(calls.length, 0, 'no service manager command is run at all');
  assert.equal(result.activation.outcome, 'skipped-by-flag');
  assert.equal(result.skippedActivation.length, 3, 'the skipped plan stays declared');
  assert.match(fs.readFileSync(installPath('linux', home), 'utf8'), /ExecStart=/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installService linux: an empty FragmentPath (unit never installed) activates as before', () => {
  const home = tmpDir('nc-n25-empty-');
  const ctx = linuxCtx(home);
  const { execImpl, ran } = systemdFake('');

  const result = installService('linux', generateLinux(ctx), ctx, { execImpl });

  assert.equal(result.activation.outcome, 'activated');
  assert.equal(ran('daemon-reload'), 1);
  assert.equal(ran('enable'), 1);
  assert.equal(ran('restart'), 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installService mac: a label already loaded from another plist is not booted out or bootstrapped', () => {
  const home = tmpDir('nc-n25-mac-');
  const ctx = { repoRoot: '/Users/user/nexuscrew', nodeBin: '/usr/local/bin/node', port: 41820, home, uid: 1000 };
  const calls = [];
  const execImpl = (bin, args) => {
    calls.push([bin, args.join(' ')]);
    if (bin === 'launchctl' && args[0] === 'print') {
      return 'gui/1000/com.mmmbuto.nexuscrew = {\n\tpath = /Users/someone-else/Library/LaunchAgents/com.mmmbuto.nexuscrew.plist\n}\n';
    }
    return '';
  };

  const result = installService('mac', generateMac(ctx), ctx, { execImpl });

  const lifecycle = calls.filter(([bin, line]) => bin === 'launchctl' && (line.startsWith('bootout') || line.startsWith('bootstrap')));
  assert.deepEqual(lifecycle, [], 'the real launchd job must be left alone');
  assert.deepEqual(result.failures, []);
  assert.equal(result.activation.outcome, 'skipped-foreign-manager');
  assert.match(result.activation.warning, /activation skipped/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installService mac: an unreadable loaded job keeps the previous behaviour (no unproven skip)', () => {
  const home = tmpDir('nc-n25-mac-unreadable-');
  const ctx = { repoRoot: '/Users/user/nexuscrew', nodeBin: '/usr/local/bin/node', port: 41820, home, uid: 1000 };
  const calls = [];
  let prints = 0;
  const execImpl = (bin, args) => {
    calls.push([bin, args.join(' ')]);
    if (bin === 'launchctl' && args[0] === 'print') {
      prints += 1;
      if (prints === 1) return 'gui/1000/com.mmmbuto.nexuscrew = {\n\tactive count = 1\n}\n';
      throw new Error('service not found');
    }
    return '';
  };

  const result = installService('mac', generateMac(ctx), ctx, { execImpl });

  assert.equal(result.activation.outcome, 'activated', 'no positive evidence of a foreign unit');
  const lifecycle = calls
    .filter(([bin, line]) => bin === 'launchctl' && (line.startsWith('bootout') || line.startsWith('bootstrap')))
    .map(([, line]) => line);
  assert.deepEqual(lifecycle, [
    'bootout gui/1000/com.mmmbuto.nexuscrew',
    `bootstrap gui/1000 ${installPath('mac', home)}`,
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: a temporary HOME the manager does not load reports the skip instead of restarting production', () => {
  const home = tmpDir('nc-n25-init-foreign-');
  const foreign = '/home/tester/.config/systemd/user/nexuscrew.service';
  const { execImpl, ran } = systemdFake(foreign);
  const lines = [];

  const result = runInit({
    platform: 'linux',
    home,
    execImpl,
    tmuxOk: true,
    printUrl: false,
    log: (line) => lines.push(line),
    selectProvider: () => ({ mode: 'disabled' }),
  });

  assert.equal(ran('restart'), 0, 'no restart of the real service');
  assert.equal(ran('enable'), 0);
  assert.equal(result.serviceActivation.outcome, 'skipped-foreign-manager');
  const warning = lines.find((line) => line.includes('activation skipped'));
  assert.ok(warning, `the skip must be visible in the output, got: ${JSON.stringify(lines)}`);
  assert.ok(warning.includes(foreign));
  assert.deepEqual(result.installFailures, [], 'a deliberate skip is not an install failure');
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: noActivate writes the definition and never probes or touches the manager', () => {
  const home = tmpDir('nc-n25-init-flag-');
  const { execImpl, calls } = systemdFake('/home/tester/.config/systemd/user/nexuscrew.service');
  const lines = [];

  const result = runInit({
    platform: 'linux',
    home,
    execImpl,
    noActivate: true,
    tmuxOk: true,
    printUrl: false,
    log: (line) => lines.push(line),
    selectProvider: () => ({ mode: 'disabled' }),
  });

  assert.deepEqual(calls, [], 'no service manager command is run at all');
  assert.equal(result.serviceActivation.outcome, 'skipped-by-flag');
  assert.ok(fs.existsSync(installPath('linux', home)), 'the unit is still written under the given HOME');
  assert.ok(lines.some((line) => line.includes('activation skipped')), JSON.stringify(lines));
  fs.rmSync(home, { recursive: true, force: true });
});
