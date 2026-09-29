// D384 commit 2 — le DUE forme di `npm pack --json` accettate dal verifier.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { packEntries } = require('../publish/pack-json-shape.js');

test('forma ARRAY di npm ≤ 11: passa invariata', () => {
  const array = [{
    filename: 'mmmbuto-nexuscrew-0.9.51.tgz',
    files: [{ path: 'package/bin/nexuscrew.js', size: 100, mode: 493 }],
  }];
  assert.deepEqual(packEntries(array), array);
});

test('forma OGGETTO di npm 12: i valori diventano l\'array di report', () => {
  const oggetto = {
    '@mmmbuto/nexuscrew': {
      filename: 'mmmbuto-nexuscrew-0.9.51.tgz',
      files: [{ path: 'package/bin/nexuscrew.js', size: 100, mode: 493 }],
    },
  };
  const array = packEntries(oggetto);
  assert.equal(array.length, 1);
  assert.equal(array[0].filename, 'mmmbuto-nexuscrew-0.9.51.tgz');
  assert.deepEqual(array[0].files, oggetto['@mmmbuto/nexuscrew'].files);
});

test('scoped package: la chiave con scope non cambia la forma', () => {
  const oggetto = { '@mmmbuto/codex-cli-termux': { filename: 'x.tgz', files: [] } };
  assert.equal(packEntries(oggetto).length, 1);
});

test('input non riconosciuto: fallisce chiudo', () => {
  assert.throws(() => packEntries(null), /formato non riconosciuto/);
  assert.throws(() => packEntries(42), /formato non riconosciuto/);
  assert.throws(() => packEntries('stringa'), /formato non riconosciuto/);
});
