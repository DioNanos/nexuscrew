'use strict';
// tests/fleet-cwd-regression.test.js — WP1R Gap 1: guestCwd e stato rimosso.
// cell.cwd resta l unico path: host-validated, persistito, tmux cwd. Nessun path
// guest interno puo sostituirlo o bypassare la validazione host.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCellCwd } = require('../lib/fleet/builtin.js');

test('guestCwd non e piu onorato: cell.cwd resta host-validated; nessun hostCwd/guestCwd nel risultato', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nccwdreg-'));
  try {
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    const real = fs.realpathSync(path.join(home, 'proj'));
    // un eventuale guestCwd legacy deve essere ignorato: cwd figlio = host cwd
    const r = resolveCellCwd({ cwd: path.join(home, 'proj'), guestCwd: '/data/guest/proj' }, home);
    assert.equal(r.ok, true);
    assert.equal(r.cwd, real, 'cwd del figlio = host cwd (guestCwd ignorato)');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'hostCwd'), false, 'nessun campo hostCwd (revert WP1)');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'guestCwd'), false);
    // senza guestCwd: behavior invariato
    const r2 = resolveCellCwd({ cwd: path.join(home, 'proj') }, home);
    assert.equal(r2.ok, true);
    assert.equal(r2.cwd, real);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
