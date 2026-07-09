'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFleet } = require('../lib/fleet/index.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');
const cfg = (over = {}) => ({ fleetEnabled: true, fleetBin: FAKE, ...over });

test('detect: disabled / binario assente / symlink / world-writable / schema estraneo → unavailable', async (t) => {
  assert.equal((await createFleet(cfg({ fleetEnabled: false }))).available, false);
  assert.equal((await createFleet(cfg({ fleetBin: '/nonexistent/fleet' }))).available, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfleet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const link = path.join(dir, 'fleet-link');
  fs.symlinkSync(FAKE, link);
  assert.equal((await createFleet(cfg({ fleetBin: link }))).available, false, 'symlink rifiutato');

  const ww = path.join(dir, 'fleet-ww');
  fs.copyFileSync(FAKE, ww); fs.chmodSync(ww, 0o777);
  assert.equal((await createFleet(cfg({ fleetBin: ww }))).available, false, 'world-writable rifiutato');

  for (const mode of ['invalid-json', 'wrong-kind', 'future-schema', 'missing-fields']) {
    process.env.FAKE_FLEET_MODE = mode;
    assert.equal((await createFleet(cfg())).available, false, `schema ${mode} rifiutato`);
  }
  delete process.env.FAKE_FLEET_MODE;
});

test('status: celle con degraded calcolato + cache', async () => {
  const fleet = await createFleet(cfg());
  assert.equal(fleet.available, true);
  const st = await fleet.status();
  const by = Object.fromEntries(st.cells.map((c) => [c.cell, c]));
  assert.equal(by.Dev.degraded, false);            // active+tmux
  assert.equal(by.Trading.degraded, false);        // inactive+no tmux
  assert.equal(by.SysAdmin.degraded, true);        // active MA tmux morto
  assert.equal(fleet.isCellSession('cloud-Dev'), true);
  assert.equal(fleet.isCellSession('worker-1'), false);
});

test('comandi: passthrough argomenti + validazioni', async () => {
  const fleet = await createFleet(cfg());
  await fleet.up('Dev', { engine: 'glm-a', boot: true });   // ok
  await fleet.down('Dev', {});                              // ok
  await fleet.engine('Dev', 'native');                      // ok
  await fleet.boot('Dev', false);                           // ok
  await assert.rejects(() => fleet.up('NotACell', {}), (e) => e.status === 400);
  await assert.rejects(() => fleet.engine('Dev', 'rm -rf'), (e) => e.status === 400);
});
