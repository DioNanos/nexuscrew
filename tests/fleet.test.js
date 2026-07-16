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
  assert.equal(by.Build.degraded, false);          // active+tmux
  assert.equal(by.Build.model, 'glm-5.2');         // optional external v1 field, if provided
  assert.equal(by.Review.model, '');               // provider-default / older external contract
  assert.equal(by.Review.degraded, false);         // inactive+no tmux
  assert.equal(by.Ops.degraded, true);             // active MA tmux morto
  assert.equal(fleet.isCellSession('work-build'), true);
  assert.equal(fleet.isCellSession('worker-1'), false);
});

test('comandi: passthrough argomenti + validazioni', async () => {
  const fleet = await createFleet(cfg());
  await fleet.up('Build', { engine: 'glm-a', boot: true }); // ok
  await fleet.down('Build', {});                            // ok
  await fleet.engine('Build', 'native');                    // ok
  await fleet.boot('Build', false);                         // ok
  await assert.rejects(() => fleet.up('NotACell', {}), (e) => e.status === 400);
  await assert.rejects(() => fleet.engine('Build', 'rm -rf'), (e) => e.status === 400);
});

test('engines dal contratto: dichiarati, fallback derivato, malformati fail-closed', async () => {
  const { parseStatus } = require('../lib/fleet/index.js');
  const cell = { cell: 'Build', tmuxSession: 'work-build', engine: 'zorp', active: true, boot: true, tmux: true, rc: '', key: '' };
  const base = { schemaVersion: 1, kind: 'ai-fleet', cells: [cell] };
  // dichiarati: stringhe e oggetti {id,label,rc}; label default = id; rc default solo per 'native'
  const withEngines = parseStatus(JSON.stringify({ ...base, engines: ['native', { id: 'zorp', label: 'Zorp 9000' }, { id: 'x1', rc: true }] }));
  assert.deepEqual(withEngines.engines, [
    { id: 'native', label: 'native', rc: true },
    { id: 'zorp', label: 'Zorp 9000', rc: false },
    { id: 'x1', label: 'x1', rc: true },
  ]);
  // assenti → [] nel parse (il fallback derivato dalle celle lo fa status())
  assert.deepEqual(parseStatus(JSON.stringify(base)).engines, []);
  assert.equal(parseStatus(JSON.stringify(base)).cells[0].model, '');
  assert.equal(parseStatus(JSON.stringify({ ...base, cells: [{ ...cell, model: 'zorp-2' }] })).cells[0].model, 'zorp-2');
  assert.equal(parseStatus(JSON.stringify({ ...base, cells: [{ ...cell, model: 42 }] })), null, 'model opzionale malformato rifiutato');
  assert.equal(parseStatus(JSON.stringify({ ...base, cells: [{ ...cell, model: 'bad\nmodel' }] })), null, 'model multilinea rifiutato');
  // malformati → intero status rifiutato (fail-closed)
  for (const bad of [[{ label: 'no-id' }], ['id non valido!'], [{ id: 'a', rc: 'yes' }], 'not-array']) {
    assert.equal(parseStatus(JSON.stringify({ ...base, engines: bad })), null, `engines ${JSON.stringify(bad)} rifiutato`);
  }
});
