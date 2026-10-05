'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

// La finestra di coalescing delle DEFINIZIONI: dentro i 2 s del TTL una sola
// lettura+parse di fleet.json per tutto il nodo (status, definitions,
// credentialStatus condividono la stessa fotografia), oltre la finestra il
// cambiamento del file torna visibile. Le mutazioni dall'interfaccia restano
// immediate: passano da commitDefs, che aggiorna la fotografia in cache.
function defsCon(engineExtra) {
  return {
    schemaVersion: 1,
    engines: [
      { id: 'sh', command: '/bin/sh', promptMode: 'send-keys' },
      {
        id: 'prova.engine', label: 'Prova',
        managed: {
          client: 'claude', provider: 'custom', displayName: 'Prova',
          protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:1/v1',
          envKey: 'PROVA_KEY', providerId: 'prova', model: 'm', permissionPolicy: 'standard',
        },
      },
      ...(engineExtra || []),
    ],
    cells: [{ id: 'Build', cwd: '/tmp', engine: 'sh' }],
  };
}

const ENGINE_DUE = {
  id: 'due.engine', label: 'Due',
  managed: {
    client: 'claude', provider: 'custom', displayName: 'Due',
    protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:1/v1',
    envKey: 'SECONDA_KEY', providerId: 'due', model: 'm', permissionPolicy: 'standard',
  },
};

async function workspace(t, defs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-defwin-'));
  const defsPath = path.join(home, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify(defs));
  const tmuxBin = path.join(home, 'fake-tmux.sh');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\ncase "$1" in list-sessions) exit 1;; *) exit 0;; esac\n');
  fs.chmodSync(tmuxBin, 0o755);
  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin });
  t.after(() => { fleet.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { fleet, defsPath };
}

test('definitions: dentro la finestra serve la fotografia in cache, non il file', async (t) => {
  const { fleet, defsPath } = await workspace(t, defsCon());
  const prima = await fleet.definitions();
  assert.ok(prima.engines.some((e) => e.id === 'sh'));
  // Edit esterna del file (fuori dall'interfaccia): entro la finestra la
  // vista serve la fotografia del giro in corso.
  fs.writeFileSync(defsPath, JSON.stringify(defsCon([ENGINE_DUE])));
  const subito = await fleet.definitions();
  assert.equal(subito.engines.some((e) => e.id === 'due.engine'), false,
    'dentro la finestra il fleet.json non si rilegge: una sola lettura+parse');
});

test('definitions: oltre la finestra il file torna visibile', async (t) => {
  const { fleet, defsPath } = await workspace(t, defsCon());
  await fleet.definitions();
  fs.writeFileSync(defsPath, JSON.stringify(defsCon([ENGINE_DUE])));
  await new Promise((r) => setTimeout(r, 2100));
  const dopo = await fleet.definitions();
  assert.equal(dopo.engines.some((e) => e.id === 'due.engine'), true,
    'la finestra serve la finestra, non il secolo');
});

test('credentialStatus: stessa finestra della fotografia definitions', async (t) => {
  const { fleet, defsPath } = await workspace(t, defsCon());
  const prima = await fleet.credentialStatus();
  assert.ok(prima.credentials.some((c) => c.envKey === 'PROVA_KEY'));
  fs.writeFileSync(defsPath, JSON.stringify(defsCon([ENGINE_DUE])));
  const subito = await fleet.credentialStatus();
  assert.equal(subito.credentials.some((c) => c.envKey === 'SECONDA_KEY'), false,
    'credentialRequirements legge la stessa fotografia, non il file per conto suo');
  await new Promise((r) => setTimeout(r, 2100));
  const dopo = await fleet.credentialStatus();
  assert.equal(dopo.credentials.some((c) => c.envKey === 'SECONDA_KEY'), true);
});
