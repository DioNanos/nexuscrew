'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validSessionName, resolveCwd, isProtectedSession, buildCreateArgs,
} = require('../lib/tmux/lifecycle.js');

test('validSessionName', () => {
  assert.equal(validSessionName('worker-glm.1'), true);
  assert.equal(validSessionName('-flag'), false);
  assert.equal(validSessionName('a b'), false);
  assert.equal(validSessionName('x'.repeat(65)), false);
  assert.equal(validSessionName(''), false);
});

test('resolveCwd: dentro home ok, symlink-escape e fuori-home rifiutati', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nchome-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncout-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const inside = path.join(home, 'proj'); fs.mkdirSync(inside);
  assert.equal(resolveCwd(inside, home), fs.realpathSync(inside));
  assert.equal(resolveCwd(outside, home), null);
  const link = path.join(home, 'esc'); fs.symlinkSync(outside, link);
  assert.equal(resolveCwd(link, home), null, 'symlink verso fuori-home rifiutato');
  assert.equal(resolveCwd(path.join(home, 'missing'), home), null);
});

test('isProtectedSession: cloud-* SEMPRE, anche senza registry (F2)', () => {
  const noFleet = () => false;
  assert.equal(isProtectedSession('cloud-Build', noFleet), true);
  assert.equal(isProtectedSession('cloud-qualunque', noFleet), true);
  assert.equal(isProtectedSession('CLOUD-x', noFleet), true);
  assert.equal(isProtectedSession('worker-1', noFleet), false);
  assert.equal(isProtectedSession('worker-1', (n) => n === 'worker-1'), true);
});

test('buildCreateArgs: preset allowlist, niente cmd libero (F1)', () => {
  assert.equal(buildCreateArgs('worker-glm.1', '/home/x/p', 'shell', {}), null,
    'nuove sessioni con punto sono rifiutate prima di invocare tmux');
  assert.deepEqual(buildCreateArgs('w1', '/home/x/p', 'shell', {}),
    ['new-session', '-d', '-s', 'w1', '-c', '/home/x/p']);
  assert.deepEqual(buildCreateArgs('w1', '/home/x/p', 'claude', {}),
    ['new-session', '-d', '-s', 'w1', '-c', '/home/x/p', 'claude']);
  assert.equal(buildCreateArgs('w1', '/home/x/p', 'rm -rf /', {}), null);
  assert.deepEqual(
    buildCreateArgs('w1', '/p', 'custom', { custom: ['mytool', '--flag', 'x'] }),
    ['new-session', '-d', '-s', 'w1', '-c', '/p', 'mytool', '--flag', 'x']);
  assert.equal(buildCreateArgs('w1', '/p', 'evil', { evil: 'stringa-non-array' }), null);
});
