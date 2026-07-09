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
