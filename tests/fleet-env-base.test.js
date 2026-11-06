'use strict';
// C17 — base ereditata delle celle interattive (client e shell).
//
// Una funzione PURA trasforma la sola base che finisce nel payload della cella:
// un TERM inutilizzabile diventa il ripiego, NO_COLOR e FORCE_COLOR spariscono
// dalla base. Non e' una modifica di minimalRuntimeEnv, che resta com'e' per
// ogni altro client tmux e servizio. L'env esplicito dell'engine viene applicato
// DOPO e vince sempre.

const { test } = require('node:test');
const assert = require('node:assert');
const env = require('../lib/runtime/env.js');

const RIPIEGO = 'xterm-256color';

test('TERM inutilizzabile diventa il ripiego: assente, vuoto, dumb e unknown, normalizzati', () => {
  for (const term of [undefined, '', 'dumb', 'DUMB', 'Dumb', ' dumb ', 'unknown', 'UNKNOWN']) {
    const out = env.baseEreditataCella(term === undefined ? {} : { TERM: term });
    assert.equal(out.TERM, RIPIEGO, `TERM ${JSON.stringify(term)}`);
  }
});

test('TERM utilizzabile resta INVARIATO, senza riscritture', () => {
  for (const term of ['xterm', 'xterm-256color', 'screen-256color', 'tmux-256color', 'linux', 'vt100']) {
    const out = env.baseEreditataCella({ TERM: term });
    assert.equal(out.TERM, term);
  }
});

test('NO_COLOR e FORCE_COLOR spariscono dalla sola base', () => {
  const out = env.baseEreditataCella({ TERM: 'xterm', NO_COLOR: '1', FORCE_COLOR: '3' });
  assert.equal('NO_COLOR' in out, false);
  assert.equal('FORCE_COLOR' in out, false);
  assert.equal(out.TERM, 'xterm');
});

test('tutto il resto resta com\'e\': COLORTERM, locale, shell, percorsi Termux e socket', () => {
  const base = {
    TERM: 'xterm',
    COLORTERM: 'truecolor',
    LANG: 'it_IT.UTF-8',
    LC_CTYPE: 'UTF-8',
    SHELL: '/bin/zsh',
    PREFIX: '/data/data/com.termux/files/usr',
    TMPDIR: '/data/data/com.termux/files/usr/tmp',
    TMUX_TMPDIR: '/data/data/com.termux/files/usr/var/run',
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
  };
  assert.deepEqual(env.baseEreditataCella(base), base);
});

test('la funzione e\' PURA: non muta l\'oggetto che riceve', () => {
  const base = { TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '1', COLORTERM: 'truecolor' };
  const copia = JSON.parse(JSON.stringify(base));
  const out = env.baseEreditataCella(base);
  assert.deepEqual(base, copia, 'l\'ingresso non si tocca');
  assert.notEqual(out, base);
  assert.equal(out.TERM, RIPIEGO);
});

test('ingressi non validi non fanno esplodere niente', () => {
  for (const v of [null, undefined, 42, 'xterm', []]) {
    const out = env.baseEreditataCella(v);
    assert.equal(typeof out, 'object');
    assert.equal(Array.isArray(out), false);
  }
});

test('minimalRuntimeEnv NON cambia per gli altri client: TERM dumb resta dumb', () => {
  // La regola C17 vive nella funzione nuova, non nel minimal env condiviso.
  const m = env.minimalRuntimeEnv({ PATH: '/bin', HOME: '/home/tester', TERM: 'dumb' }, { home: '/home/tester' });
  assert.equal(m.TERM, 'dumb');
  const u = env.minimalRuntimeEnv({ PATH: '/bin', HOME: '/home/tester', TERM: 'unknown' }, { home: '/home/tester' });
  assert.equal(u.TERM, 'unknown');
});
