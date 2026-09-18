'use strict';
// tests/cli-doctor-tmux-server-cwd.test.js — «assente» non e' «non ho potuto
// guardare».
//
// La sonda del cwd del server tmux classificava OGNI errore come «server non
// attivo»: anche un `Permission denied` sul socket, che e' un'altra cosa e ha
// un'altra rimedio. Un server spento e' uno stato normale (la probe si rinvia al
// primo avvio); una sonda che non si e' potuta fare e' un'informazione mancante,
// e va detta come tale invece di essere collassata nel primo caso.
const { test } = require('node:test');
const assert = require('node:assert');
const { checkTmuxServerCwd } = require('../lib/cli/doctor.js');

const ASSENTE = 'server tmux non attivo; probe rinviato al primo avvio';

test('server assente (no server running): rinvia, non fallisce', () => {
  const exec = () => { throw new Error('no server running on /tmp/tmux-1000/default'); };
  const out = checkTmuxServerCwd('linux', exec);
  assert.equal(out.ok, true);
  assert.equal(out.warn, true);
  assert.equal(out.detail, ASSENTE);
});

test('socket inesistente (ENOENT): e\' un server assente, non un errore di sonda', () => {
  const err = new Error('spawnSync tmux ENOENT');
  err.code = 'ENOENT';
  const out = checkTmuxServerCwd('linux', () => { throw err; });
  assert.equal(out.ok, true);
  assert.equal(out.warn, true);
  assert.doesNotMatch(out.detail, /probe non verificabile/);
});

test('Permission denied sul socket: NON e\' «server non attivo», e la causa e\' nominata', () => {
  const err = new Error('error connecting to /tmp/tmux-1000/default (Permission denied)');
  err.code = 'EACCES';
  const out = checkTmuxServerCwd('linux', () => { throw err; });
  assert.notEqual(out.detail, ASSENTE, 'un EACCES non e\' un server spento');
  assert.match(out.detail, /probe non verificabile/);
  assert.match(out.detail, /EACCES|Permission denied/);
  assert.equal(out.ok, false, 'una sonda che non si e\' potuta fare non e\' un esito sano');
  assert.equal(out.warn, true);
});

test('errore senza codice: la causa e\' il messaggio, non un silenzio', () => {
  const out = checkTmuxServerCwd('linux', () => { throw new Error('tmux: unexpected failure'); });
  assert.match(out.detail, /^probe non verificabile: /);
  assert.match(out.detail, /unexpected failure/);
  assert.equal(out.ok, false);
});

test('server presente e cwd risolvibile: ok, e il percorso NON compare', () => {
  const out = checkTmuxServerCwd('linux', () => '4242\n', { procCwdImpl: () => '/home/qualcuno' });
  assert.equal(out.ok, true);
  assert.equal(out.warn, undefined);
  assert.equal(out.detail, 'cwd risolvibile');
  assert.doesNotMatch(out.detail, /home\/qualcuno/);
});

test('pid non numerico: «non rilevato», che e\' un terzo caso distinto', () => {
  const out = checkTmuxServerCwd('linux', () => 'non-un-pid\n');
  assert.equal(out.ok, true);
  assert.equal(out.warn, true);
  assert.match(out.detail, /non rilevato/);
});

test('cwd non risolvibile con server VIVO: resta un fallimento con il suo rimedio', () => {
  const out = checkTmuxServerCwd('linux', () => '4242\n', {
    procCwdImpl: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(out.ok, false);
  assert.match(out.detail, /non risolvibile/);
  assert.doesNotMatch(out.detail, /probe non verificabile/, 'il server c\'e\': la sonda si e\' fatta');
});

test('piattaforma non applicabile: ne\' sonda ne\' allarme', () => {
  const out = checkTmuxServerCwd('darwin', () => { throw new Error('EACCES'); });
  assert.equal(out.ok, true);
  assert.equal(out.warn, undefined);
  assert.match(out.detail, /non applicabile/);
});
