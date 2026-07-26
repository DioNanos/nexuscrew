'use strict';
// tests/fleet-cwd-guest.test.js — WP1 punto 1: hostCwd (path host validato) vs
// guestCwd (cwd effettiva del figlio, NON validata sul host). Per engine Proot
// il figlio gira in un namespace dove i path sono guest: un guestCwd valido non
// deve generare un falso CWD_INVALID sul host. hostCwd invalido -> fail-closed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCellCwd } = require('../lib/fleet/builtin.js');
const { parseCell } = require('../lib/fleet/definitions.js');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ncguest-'));
  fs.mkdirSync(path.join(h, 'proj'), { recursive: true });
  return h;
}

test('guestCwd valido (path guest NON esistente sul host): nessun falso CWD_INVALID; hostCwd validato', () => {
  const h = home();
  try {
    const r = resolveCellCwd({ cwd: path.join(h, 'proj'), guestCwd: '/data/guest/proj' }, h);
    assert.equal(r.ok, true);
    assert.equal(r.cwd, '/data/guest/proj', 'la cwd del figlio e il guestCwd');
    assert.equal(r.hostCwd, fs.realpathSync(path.join(h, 'proj')), 'hostCwd validato sotto home');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('hostCwd (cwd) invalido -> fail-closed invalid-cwd anche se guestCwd e presente', () => {
  const h = home();
  try {
    const r = resolveCellCwd({ cwd: path.join(h, 'definitely-missing'), guestCwd: '/data/guest/proj' }, h);
    assert.equal(r.ok, false);
    assert.equal(r.fail.reason, 'invalid-cwd');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('senza guestCwd: cwd legacy validata sul host, hostCwd coincide con cwd (no regressione)', () => {
  const h = home();
  try {
    const r = resolveCellCwd({ cwd: path.join(h, 'proj') }, h);
    assert.equal(r.ok, true);
    assert.equal(r.cwd, fs.realpathSync(path.join(h, 'proj')));
    assert.equal(r.hostCwd, r.cwd);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('guestCwd prende atto del path guest come cwd del figlio; cwdRel resta derivato dal hostCwd', () => {
  const h = home();
  try {
    const r = resolveCellCwd({ cwd: path.join(h, 'proj'), guestCwd: '/root/ns' }, h);
    assert.equal(r.ok, true);
    assert.equal(r.cwd, '/root/ns');
    assert.equal(r.cwdRel, 'proj', 'cwdRel portabile riferito al hostCwd, non al guest');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

// --- parseCell: guestCwd e un campo valido (formato); guestCwd invalido -> null ---

test('parseCell accetta guestCwd valido e lo mantiene; rifiuta guestCwd malformato', () => {
  const engineIds = new Set(['shell.local']);
  const engineMap = new Map([['shell.local', { id: 'shell.local', managed: { client: 'shell' } }]]);
  const ok = parseCell({ id: 'cell-1', cwd: '/home/x/proj', engine: 'shell.local', guestCwd: '/data/guest/proj' }, engineIds, engineMap);
  assert.ok(ok);
  assert.equal(ok.guestCwd, '/data/guest/proj');

  // guestCwd non-stringa -> cella rifiutata (fail-closed sul formato)
  assert.equal(parseCell({ id: 'cell-1', cwd: '/home/x/proj', engine: 'shell.local', guestCwd: 42 }, engineIds, engineMap), null);
  // guestCwd vuoto -> rifiutato
  assert.equal(parseCell({ id: 'cell-1', cwd: '/home/x/proj', engine: 'shell.local', guestCwd: '' }, engineIds, engineMap), null);
});
