'use strict';
// B4.3 — test del service companion boot.
// Copre: bootCells (lib/fleet/boot.js), generateFleetService + migrationGate
// (lib/cli/fleet-service.js) e il subcomando CLI 'fleet-boot' (commands.js).
// Vincoli rispettati: testa SOLO i nuovi moduli + dispatch; NON tocca builtin/
// provider/server/service/init. Mock fleet + exec iniettati (no tmux/systemd reali).
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCells } = require('../lib/fleet/boot.js');
const {
  generateFleetService, generateFleetLinux, generateFleetMac, generateFleetTermux,
  migrationGate, deriveRepoRoot,
} = require('../lib/cli/fleet-service.js');
const { dispatch, runFleetBoot } = require('../lib/cli/commands.js');

// --- helpers ---

function httpError(status, msg) { return Object.assign(new Error(msg), { status }); }

// fleet mock: status ritorna cells[]; up e' una funzione id -> result|throw
function mockFleet(cells, up) {
  return {
    available: true,
    status: async () => ({ cells }),
    up,
  };
}

// ---------------------------------------------------------------------------
// 1. bootCells — started / skipped / failed
// ---------------------------------------------------------------------------

test('bootCells: up ok -> started; boot:false ignorata', async () => {
  const fleet = mockFleet(
    [
      { cell: 'Dev', boot: true },
      { cell: 'Personal', boot: false },
      { cell: 'Trading', boot: true },
    ],
    async () => ({ ok: true }),
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started.sort(), ['Dev', 'Trading']);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.failed.length, 0);
});

test('bootCells: 409 (duplicate) -> skipped, non fatale', async () => {
  const fleet = mockFleet(
    [{ cell: 'Dev', boot: true }, { cell: 'SysAdmin', boot: true }],
    async (id) => { if (id === 'Dev') throw httpError(409, 'sessione già in esecuzione'); return { ok: true }; },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, ['SysAdmin']);
  assert.deepEqual(r.skipped, ['Dev']);
  assert.equal(r.failed.length, 0);
});

test('bootCells: errore non-409 -> failed (NON ferma le altre celle)', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }, { cell: 'C', boot: true }],
    async (id) => {
      if (id === 'A') return { ok: true };
      if (id === 'B') throw httpError(500, 'tmux down');
      if (id === 'C') throw new Error('generic boom'); // senza status -> failed
    },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, ['A']);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.failed.length, 2);
  assert.deepEqual(r.failed.map((f) => f.cell), ['B', 'C']);
  assert.match(r.failed[0].reason, /tmux down/);
  assert.match(r.failed[1].reason, /generic boom/);
});

test('bootCells: fleet unavailable -> vuoto, no crash', async () => {
  const r = await bootCells({ available: false }, { log: () => {} });
  assert.deepEqual(r, { started: [], skipped: [], failed: [] });
});

test('bootCells: ordine preservato + log chiamato (started/skipped/failed)', async () => {
  const logs = [];
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }, { cell: 'C', boot: true }],
    async (id) => {
      if (id === 'B') throw httpError(409, 'dup');
      if (id === 'C') throw httpError(500, 'x');
      return { ok: true };
    },
  );
  const r = await bootCells(fleet, { log: (m) => logs.push(m) });
  assert.deepEqual(r.started, ['A']);
  assert.deepEqual(r.skipped, ['B']);
  assert.deepEqual(r.failed.map((f) => f.cell), ['C']);
  assert.ok(logs.some((l) => /started A/.test(l)));
  assert.ok(logs.some((l) => /skipped B/.test(l)));
  assert.ok(logs.some((l) => /failed C/.test(l)));
});

test('bootCells: nessuna cella boot:true -> tutto vuoto', async () => {
  const fleet = mockFleet([{ cell: 'A', boot: false }], async () => ({ ok: true }));
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, []);
});

// ---------------------------------------------------------------------------
// 2. generateFleetService — snapshot leggeri su stringhe chiave (ExecStart, fleet-boot)
// ---------------------------------------------------------------------------

const SVC = {
  nodeBin: '/usr/bin/node',
  entryPath: '/home/user/nexuscrew/bin/nexuscrew.js',
  home: '/home/user',
};

test('deriveRepoRoot: .../bin/nexuscrew.js -> repo root', () => {
  assert.equal(deriveRepoRoot('/home/user/nexuscrew/bin/nexuscrew.js'), '/home/user/nexuscrew');
});

test('generateFleetService linux: systemd nexuscrew-fleet + ExecStart fleet-boot', () => {
  const s = generateFleetService({ ...SVC, platform: 'linux' });
  assert.match(s, /\[Unit\]/);
  assert.match(s, /\[Service\]/);
  assert.match(s, /\[Install\]/);
  assert.match(s, /Type=oneshot/);
  assert.match(s, /Description=NexusCrew fleet boot companion/);
  // ExecStart = <node> <entry> fleet-boot (argv separato, no shell)
  assert.match(s, /ExecStart=\/usr\/bin\/node \/home\/user\/nexuscrew\/bin\/nexuscrew\.js fleet-boot/);
  assert.match(s, /Environment=PATH=/); // PATH controllato dal service
  assert.match(s, /WantedBy=default\.target/);
});

test('generateFleetService mac: launchd plist com.mmmbuto.nexuscrew-fleet + ProgramArguments', () => {
  const s = generateFleetService({ ...SVC, platform: 'mac' });
  assert.match(s, /<\?xml/);
  assert.match(s, /<plist version="1\.0">/);
  assert.match(s, /<key>Label<\/key>\s*<string>com\.mmmbuto\.nexuscrew-fleet<\/string>/);
  assert.match(s, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.match(s, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(s, /<string>fleet-boot<\/string>/); // terzo arg = fleet-boot
  assert.match(s, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(s, /fleet-boot\.log/);
  // NESSUN placeholder <home> raw (parita' R2 con service.js)
  assert.ok(!s.includes('<home>'));
});

test('generateFleetService termux: boot script + exec fleet-boot + log redirect', () => {
  const s = generateFleetService({ ...SVC, platform: 'termux' });
  assert.match(s, /^#!\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
  assert.match(s, /export PATH=\/data\/data\/com\.termux\/files\/usr\/bin:\$PATH/);
  assert.match(s, /export HOME=\/data\/data\/com\.termux\/files\/home/);
  assert.match(s, /exec '\/usr\/bin\/node' '\/home\/user\/nexuscrew\/bin\/nexuscrew\.js' fleet-boot/);
  assert.match(s, />> "\$HOME\/\.nexuscrew\/fleet-boot\.log" 2>&1/);
});

test('generateFleetService: unsupported platform -> throw', () => {
  assert.throws(() => generateFleetService({ ...SVC, platform: 'win32' }), /unsupported platform/);
});

test('generateFleetLinux: reject char hostile $ (M3 parity con service.js)', () => {
  assert.throws(
    () => generateFleetLinux({ nodeBin: '/usr/bin/$node', entryPath: '/h/r/bin/nexuscrew.js' }),
    /non supportati in systemd/,
  );
});

// ---------------------------------------------------------------------------
// 3. migrationGate — blocked quando ci sono unit, pass quando vuoto/errore (no systemd)
// ---------------------------------------------------------------------------

test('migrationGate: unit cloud-cell@ abilitate -> blocked + remediation', () => {
  const out = 'UNIT FILE                     STATE   PRESET\n'
    + 'cloud-cell@Dev.service        enabled enabled\n'
    + 'cloud-cell@Personal.service   enabled enabled\n\n'
    + '2 unit files listed.\n';
  const r = migrationGate({ exec: () => out, platform: 'linux' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.units.sort(), ['cloud-cell@Dev.service', 'cloud-cell@Personal.service']);
  assert.ok(r.remediation);
  assert.match(r.remediation, /disabilita|fleet esterno|doppio boot/i);
});

test('migrationGate: nessuna unit -> pass', () => {
  const exec = () => 'UNIT FILE                     STATE   PRESET\n\n0 unit files listed.\n';
  const r = migrationGate({ exec, platform: 'linux' });
  assert.equal(r.blocked, false);
  assert.equal(r.units.length, 0);
});

test('migrationGate: comando fallisce (no systemd) -> pass, non blocca', () => {
  const exec = () => { throw new Error('systemctl: not found'); };
  const r = migrationGate({ exec, platform: 'linux' });
  assert.equal(r.blocked, false);
  assert.equal(r.units.length, 0);
  assert.match(r.reason, /systemctl|command error|not found/);
});

test('migrationGate: piattaforma non linux -> pass (no systemd)', () => {
  const r = migrationGate({ platform: 'mac' });
  assert.equal(r.blocked, false);
  assert.equal(r.units.length, 0);
  assert.match(r.reason, /no systemd/);
});

test('migrationGate: exec riceve argv diretto (execFile, MAI shell string)', () => {
  let seen = null;
  const exec = (bin, args) => { seen = { bin, args }; return ''; };
  migrationGate({ exec, platform: 'linux' });
  assert.equal(seen.bin, 'systemctl');
  assert.ok(Array.isArray(seen.args), 'args è un array argv (execFile), non una shell string');
  assert.deepEqual(seen.args, ['--user', 'list-unit-files', '--state=enabled', 'cloud-cell@*']);
});

test('migrationGate: ignora righe non-cloud-cell nel list', () => {
  const out = 'UNIT FILE                     STATE   PRESET\n'
    + 'nexuscrew.service             enabled enabled\n'
    + 'cloud-cell@Dev.service        enabled enabled\n';
  const r = migrationGate({ exec: () => out, platform: 'linux' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.units, ['cloud-cell@Dev.service']); // solo la cloud-cell@
});

// ---------------------------------------------------------------------------
// 4. CLI subcommand 'fleet-boot' (dispatch glue + runFleetBoot)
// ---------------------------------------------------------------------------

// Esegue dispatch(['fleet-boot'], opts) e attende il code via exit callback iniettata.
async function runBootDispatch(opts) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const r = dispatch(['fleet-boot'], { exit: (c) => resolve(c), cfg: {}, log: () => {}, ...opts });
  const code = await done;
  return { code, r };
}

test('dispatch fleet-boot: builtin con failed -> exit 1', async () => {
  const fleet = mockFleet([{ cell: 'A', boot: true }], async () => { throw httpError(500, 'nope'); });
  const { code, r } = await runBootDispatch({ selectProvider: async () => ({ mode: 'builtin', fleet }) });
  assert.equal(r.keepAlive, true); // processo tenuto vivo finche' la catena async non chiama exit
  assert.equal(code, 1);
});

test('dispatch fleet-boot: builtin tutto ok -> exit 0', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async () => ({ ok: true }),
  );
  const { code } = await runBootDispatch({ selectProvider: async () => ({ mode: 'builtin', fleet }) });
  assert.equal(code, 0);
});

test('dispatch fleet-boot: builtin con 409 -> exit 0 (skip non fatale)', async () => {
  const fleet = mockFleet([{ cell: 'A', boot: true }], async () => { throw httpError(409, 'dup'); });
  const { code } = await runBootDispatch({ selectProvider: async () => ({ mode: 'builtin', fleet }) });
  assert.equal(code, 0); // solo skipped, failed vuoto
});

test('dispatch fleet-boot: external -> exit 0 (boot gestito dal fleet esterno)', async () => {
  const logs = [];
  const { code } = await runBootDispatch({
    log: (m) => logs.push(m),
    selectProvider: async () => ({ mode: 'external', fleet: { available: true } }),
  });
  assert.equal(code, 0);
  assert.ok(logs.some((l) => /fleet esterno/i.test(l)));
});

test('dispatch fleet-boot: disabled -> exit 0', async () => {
  const { code } = await runBootDispatch({
    selectProvider: async () => ({ mode: 'disabled', fleet: { available: false }, reason: 'nessun provider' }),
  });
  assert.equal(code, 0);
});

test('runFleetBoot: READONLY emerge come failed 403 -> exit 1 (no short-circuit)', async () => {
  // up lancerebbe 403 in READONLY: lo simuliamo esplicitamente (design §9d).
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async () => { throw httpError(403, 'READONLY: up bloccato'); },
  );
  const r = await runFleetBoot({
    log: () => {},
    cfg: {},
    selectProvider: async () => ({ mode: 'builtin', fleet }),
  });
  assert.equal(r.code, 1);
  assert.equal(r.summary.failed.length, 2); // entrambe fallite 403
});
