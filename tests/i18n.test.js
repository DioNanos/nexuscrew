'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('i18n: parità chiavi it/en/es, nessuna stringa vuota', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const keys = Object.keys(DICTS.it).sort();
  assert.ok(keys.length > 10, 'dizionario IT popolato');
  for (const lang of ['en', 'es']) {
    assert.deepEqual(Object.keys(DICTS[lang]).sort(), keys, `chiavi ${lang} = chiavi it`);
    for (const k of keys) assert.ok(DICTS[lang][k].trim(), `${lang}.${k} non vuota`);
  }
});

test('i18n: t() fallback su IT e su chiave', async () => {
  const { t, DICTS } = await import('../frontend/src/lib/i18n.js');
  assert.equal(t('__missing__'), '__missing__');
  assert.ok(DICTS.it.sessions);
});

// Fino alla 0.8.47 questo aiuto diceva che trascinare non fa scorrere i TUI a
// schermo intero, e il test fissava quella frase. Dalla 0.8.48 non e' piu' vero:
// un'applicazione che segue il mouse riceve i report della rotella e scorre da
// se'. Il testo e' stato corretto, e con lui questa guardia — che ora vincola la
// SOSTANZA (l'aiuto distingue i due casi) invece di una formulazione, cosi' una
// riscrittura non la rompe ma un testo che smette di spiegare la fa cadere.
test('i18n: alternateScreen distingue chi scorre da se\' da chi naviga la storia tmux', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const it = DICTS.it['alternate-screen-help'];
  const en = DICTS.en['alternate-screen-help'];
  const es = DICTS.es['alternate-screen-help'];
  assert.match(it, /segue il mouse.*scorre da s/i);
  assert.match(it, /storia di tmux/i);
  assert.match(en, /tracks the mouse.*scrolls on its own/i);
  assert.match(en, /tmux scrollback/i);
  assert.match(es, /sigue el rat.n.*se desplaza sola/i);
  assert.match(es, /historial de tmux/i);
  // La vecchia affermazione non deve tornare in nessuna lingua: era falsa.
  for (const text of [it, en, es]) {
    assert.ok(!/non scorre i TUI|does not scroll full-screen|no desplaza los TUI/i.test(text),
      'l\'aiuto non deve tornare a negare uno scorrimento che ora avviene');
  }
});
