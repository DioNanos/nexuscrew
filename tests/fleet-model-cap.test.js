'use strict';
// tests/fleet-model-cap.test.js — il cap dei modelli dichiarati e' 128, e
// superarlo si vede nel messaggio, non in un rifiuto generico.
//
// Il catalogo di un nodo reale ha saturato il cap precedente (64):
// `define-model` rispondeva 400 «validazione fallita» senza dire PERCHE', e
// chi riceve l'errore non poteva sapere che il limite era quello. Il rifiuto
// nomina il cap, sul modello gia' usato per gli engine (messaggio esplicito
// nel parser) e sull'issue che il comando propaga nel 400.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'claude.alibaba-token-plan';

// Niente file su disco per i test di parser: basta l'oggetto gia' parsato.
function defsConModelli(n) {
  return {
    schemaVersion: 1,
    engines: [],
    cells: [],
    models: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, engine: PROFILO })),
  };
}

test('65 modelli dichiarati passano il parser', () => {
  const parsed = parseDefinitions(JSON.stringify(defsConModelli(65)));
  assert.ok(parsed, '65 dichiarazioni sono dentro il cap e non devono essere rifiutate');
  assert.equal(parsed.models.length, 65);
});

test('128 modelli dichiarati passano il parser (il cap esatto e\' accettato)', () => {
  const parsed = parseDefinitions(JSON.stringify(defsConModelli(128)));
  assert.ok(parsed, '128 dichiarazioni sono il cap e devono essere accettate');
  assert.equal(parsed.models.length, 128);
});

test('129 modelli: il parser rifiuta nominando il cap', () => {
  let motivo = null;
  const parsed = parseDefinitions(JSON.stringify(defsConModelli(129)), {
    onReject: (reason) => { motivo = reason; },
  });
  assert.equal(parsed, null, 'oltre il cap il documento e\' rifiutato');
  assert.match(String(motivo), /cap 128/, 'il rifiuto deve nominare il limite');
});

test('define-model oltre il cap risponde 400 nominando il cap', async (t) => {
  // Il giro completo che ha smascherato il limite: catalogo pieno, il
  // comando di dichiarazione deve fallire DICENDO che il limite e' quello.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-model-cap-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [],
    cells: [],
    models: Array.from({ length: 128 }, (_, i) => ({ id: `m${i}`, engine: PROFILO })),
  }));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin });
  await assert.rejects(() => fleet.defineModel({ id: 'm128', engine: PROFILO }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /cap 128/, 'il 400 deve nominare il limite, non restare generico');
    return true;
  });
});
