'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');

test('atomicWrite: rifiuto strutturale senza cause separa il messaggio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-definitions-error-'));
  const target = path.join(dir, 'fleet.json');
  try {
    assert.throws(
      () => atomicWrite(target, {
        schemaVersion: 1,
        engines: [{
          id: 'shell',
          managed: { client: 'shell', provider: 'native', outsideManagedKeys: true },
        }],
        cells: [],
      }),
      (error) => {
        assert.equal(error.message, 'definizioni fleet non valide — validazione fallita');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
