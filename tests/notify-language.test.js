'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeNotificationLang } = require('../lib/notify/language.js');

test('notification lang: accepts supported bases and canonicalizes BCP-47 subtags', () => {
  assert.equal(normalizeNotificationLang('it'), 'it');
  assert.equal(normalizeNotificationLang(' IT-it '), 'it-IT');
  assert.equal(normalizeNotificationLang('en-us'), 'en-US');
  assert.equal(normalizeNotificationLang('es-419'), 'es-419');
  assert.equal(normalizeNotificationLang('en-latn-us'), 'en-Latn-US');
});

test('notification lang: rejects unsupported, malformed and non-string values', () => {
  for (const value of ['xx', 'italian', 'it_', 'it--IT', '', '   ', null, undefined, 7]) {
    assert.equal(normalizeNotificationLang(value), null, String(value));
  }
});
