'use strict';
// Test del boot companion come client del daemon persistente.
// Il boot e' un CLIENT del daemon persistente: niente builtin, leaseManager o
// broker nel processo oneshot. Copre: bootCells (lib/fleet/boot.js) con lo skip
// QUALIFICATO dei 409 (solo campi strutturati: fleetCode del body, classification
// di launch-state, lease per cella — mai una regex sul messaggio), il client
// del daemon (discovery, identita' attesa, readiness con supervision,
// POST /api/fleet/up con il SOLO target), generateFleetService + migrationGate
// e il dispatch CLI 'fleet-boot' (commands.js).
// Nessun tmux/systemd reale qui: il processo vero e' in fleet-boot-process.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { bootCells } = require('../lib/fleet/boot.js');
const { createBootClient } = require('../lib/fleet/boot-client.js');
const {
  generateFleetService, generateFleetLinux, generateFleetMac, generateFleetTermux,
  migrationGate, deriveRepoRoot,
} = require('../lib/cli/fleet-service.js');
const { dispatch, runFleetBoot } = require('../lib/cli/commands.js');

// --- helpers ---

// Errore HTTP come lo produce l'adattatore del client: .status, .fleetCode
// (enum chiuso del body), .data strutturato opzionale. Un errore senza status
// non e' un verdetto HTTP (rete persa): chi lo simula usa lostError().
function httpError(status, msg, extra = {}) {
  return Object.assign(new Error(msg), { status, ...extra });
}
function lostError(msg = 'up: risposta persa') { return Object.assign(new Error(msg), { lost: true }); }

// fleet mock: contratto adapter {available, status, up, launchState?}.
// up: funzione (id) => result | throw; launchState: (id) => json | null.
function mockFleet(cells, up, launchState) {
  return {
    available: true,
    status: async () => ({ cells }),
    up,
    ...(launchState ? { launchState } : {}),
  };
}

// Lo stato che attesta «gia' in esecuzione, provata»: record v2 in fase
// attested (launchId + phase esistono solo nello schema a fasi v2),
// classification live (canale di controllo posseduto vivo), lease della
// cella live nello status (il supervisore di quel lancio rinnova ORA) e
// control del manager ARMATO, CONNESSO e legato allo STESSO launchId.
function attesaViva(over = {}) {
  const launchId = 'cd'.repeat(8);
  return {
    ok: true, cell: 'A', classification: 'live', launchId, phase: 'attested',
    control: { armed: true, connected: true, launchId },
    ...over,
  };
}
function statusConLease(cells) {
  return { available: true, cells };
}

// ---------------------------------------------------------------------------
// 1. bootCells — started / skipped (qualificato) / failed / unconfirmed
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
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.unconfirmed, []);
});

test('bootCells: 409 SESSION_DUPLICATE con prova (live+attested+lease live) -> skipped qualificato', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async (id) => { if (id === 'A') throw httpError(409, 'sessione già in esecuzione', { fleetCode: 'SESSION_DUPLICATE' }); return { ok: true }; },
    async (id) => (id === 'A' ? attesaViva() : null),
  );
  fleet.status = async () => statusConLease([
    { cell: 'A', boot: true, lease: 'live' },
    { cell: 'B', boot: true, lease: 'none' },
  ]);
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, ['B']);
  assert.deepEqual(r.skipped, [{ cell: 'A', code: 'ALREADY_RUNNING' }]);
  assert.equal(r.failed.length, 0);
});

test('bootCells: 409 SESSION_DUPLICATE senza launchState -> failed (nessuna prova)', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async () => { throw httpError(409, 'dup', { fleetCode: 'SESSION_DUPLICATE' }); },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }]);
});

test('bootCells: 409 SESSION_DUPLICATE con launchState none (omonima senza record) -> failed', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async () => { throw httpError(409, 'sessione già in esecuzione', { fleetCode: 'SESSION_DUPLICATE' }); },
    async () => ({ ok: true, classification: 'none', launchId: null, phase: null }),
  );
  fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'none' }]);
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }]);
});

test('bootCells: 409 SESSION_DUPLICATE con live ma lease none -> failed (manca la supervisione)', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async () => { throw httpError(409, 'dup', { fleetCode: 'SESSION_DUPLICATE' }); },
    async () => attesaViva(),
  );
  fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'none' }]);
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }]);
});

test('bootCells: lo skip esige il control ARMATO, CONNESSO e legato allo STESSO lancio', async () => {
  const launchId = 'cd'.repeat(8);
  const casi = [
    ['control assente (daemon che non lo espone)', attesaViva({ control: undefined })],
    ['control disarmato (canale tmux vivo, protocollo di stop non armato)', attesaViva({ control: { armed: false, connected: false, launchId } })],
    ['control armato per un ALTRO lancio', attesaViva({ control: { armed: true, connected: true, launchId: 'ff'.repeat(8) } })],
    ['control armato e legato ma non connesso', attesaViva({ control: { armed: true, connected: false, launchId } })],
  ];
  for (const [etichetta, launchState] of casi) {
    const fleet = mockFleet(
      [{ cell: 'A', boot: true }],
      async () => { throw httpError(409, 'dup', { fleetCode: 'SESSION_DUPLICATE' }); },
      async () => launchState,
    );
    fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'live' }]);
    const r = await bootCells(fleet, { log: () => {} });
    assert.deepEqual(r.skipped, [], `${etichetta}: nessuno skip`);
    assert.deepEqual(r.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }], `${etichetta}: fallimento dichiarato`);
  }
});

test('bootCells: 409 SENZA code (legacy/untagged) -> failed, mai skip', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async () => { throw httpError(409, 'sessione già in esecuzione'); },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'UNKNOWN' }]);
});

test('bootCells: STOP_UNKNOWN e VL_ROOT_COLLISION -> failed, mai skip', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async (id) => {
      if (id === 'A') throw httpError(409, 'lancio incerto', { fleetCode: 'STOP_UNKNOWN' });
      throw httpError(409, 'claim trattenuta', { fleetCode: 'VL_ROOT_COLLISION', data: { outcome: 'collision' } });
    },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.failed, [
    { cell: 'A', code: 'STOP_UNKNOWN' },
    { cell: 'B', code: 'VL_ROOT_COLLISION' },
  ]);
});

test('bootCells: VL_LAUNCH_COOLDOWN -> failed senza retry (un solo up per cella)', async () => {
  const upCalls = [];
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async (id) => {
      upCalls.push(id);
      if (id === 'A') throw httpError(409, 'cooldown', { fleetCode: 'VL_LAUNCH_COOLDOWN' });
      return { ok: true };
    },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(upCalls, ['A', 'B'], 'nessun secondo POST per la cella in cooldown');
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'VL_LAUNCH_COOLDOWN' }]);
  assert.deepEqual(r.started, ['B']);
});

test('bootCells: errore non-HTTP (senza status) -> failed, le altre continuano', async () => {
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }, { cell: 'C', boot: true }],
    async (id) => {
      if (id === 'A') return { ok: true };
      if (id === 'B') throw httpError(500, 'tmux down');
      if (id === 'C') throw new Error('generic boom');
    },
  );
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, ['A']);
  assert.deepEqual(r.failed.map((f) => f.cell), ['B', 'C']);
  assert.equal(r.failed.every((f) => typeof f.code === 'string'), true);
});

test('bootCells: risposta persa con conferma live -> skipped; senza conferma -> unconfirmed, mai secondo POST', async () => {
  const upCalls = [];
  const conferma = { A: true, B: false };
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }],
    async (id) => {
      upCalls.push(id);
      throw lostError();
    },
    async (id) => (conferma[id] ? attesaViva({ cell: id }) : { ok: true, classification: 'none', launchId: null, phase: null }),
  );
  fleet.status = async () => statusConLease([
    { cell: 'A', boot: true, lease: 'live' },
    { cell: 'B', boot: true, lease: 'none' },
  ]);
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(upCalls, ['A', 'B'], 'un solo POST per cella anche con risposta persa');
  assert.deepEqual(r.skipped, [{ cell: 'A', code: 'ALREADY_RUNNING' }]);
  assert.deepEqual(r.unconfirmed, [{ cell: 'B', code: 'LOST' }]);
  assert.equal(r.failed.length, 0);
});

test('bootCells: risposta persa con lancio ancora in corso -> consultazione bounded finché il verdetto matura -> skip qualificato', async () => {
  const upCalls = [];
  let consulte = 0;
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async (id) => { upCalls.push(id); throw lostError(); },
    async (id) => {
      consulte += 1;
      // Le prime consultazioni vedono il lancio del POST consegnato ancora
      // in corso: nessun verdetto, né attestabile né definitivamente negativo.
      if (consulte <= 2) {
        return { ok: true, cell: id, inFlight: true, classification: 'busy', launchId: null, phase: null };
      }
      return attesaViva({ cell: id });
    },
  );
  fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'live' }]);
  const r = await bootCells(fleet, { log: () => {}, lostState: { budgetMs: 5000, tickMs: 1 } });
  assert.deepEqual(upCalls, ['A'], 'mai un secondo POST');
  assert.equal(consulte, 3, 'il verdetto matura alla terza consultazione');
  assert.deepEqual(r.skipped, [{ cell: 'A', code: 'ALREADY_RUNNING' }]);
  assert.deepEqual(r.unconfirmed, []);
  assert.deepEqual(r.failed, []);
});

test('bootCells: risposta persa con lancio in corso per tutto il budget -> unconfirmed, consultazione bounded', async () => {
  const upCalls = [];
  let consulte = 0;
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async (id) => { upCalls.push(id); throw lostError(); },
    async (id) => {
      consulte += 1;
      return { ok: true, cell: id, inFlight: true, classification: 'busy', launchId: null, phase: null };
    },
  );
  fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'live' }]);
  const r = await bootCells(fleet, { log: () => {}, lostState: { budgetMs: 20, tickMs: 2 } });
  assert.deepEqual(upCalls, ['A'], 'mai un secondo POST');
  assert.ok(consulte >= 2 && consulte <= 15, `consultazioni bounded entro il budget, non ${consulte}`);
  assert.deepEqual(r.unconfirmed, [{ cell: 'A', code: 'LOST' }]);
});

test('bootCells: 409 SESSION_DUPLICATE con lancio in corso -> consultazione UNICA, subito failed (il budget della consultazione è solo della risposta persa)', async () => {
  let consulte = 0;
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }],
    async () => {
      const e = new Error('sessione già in esecuzione');
      e.status = 409;
      e.fleetCode = 'SESSION_DUPLICATE';
      throw e;
    },
    async (id) => {
      consulte += 1;
      return { ok: true, cell: id, inFlight: true, classification: 'busy', launchId: null, phase: null };
    },
  );
  fleet.status = async () => statusConLease([{ cell: 'A', boot: true, lease: 'live' }]);
  const r = await bootCells(fleet, { log: () => {}, lostState: { budgetMs: 5000, tickMs: 1 } });
  assert.equal(consulte, 1, 'il 409 NON aspetta: una sola consultazione');
  assert.deepEqual(r.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.unconfirmed, []);
});

test('bootCells: status() fallisce -> fallimento globale, nessuna cella processata', async () => {
  const fleet = { available: true, status: async () => { throw new Error('boom'); }, up: async () => { throw new Error('non chiamato'); } };
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.failed, [{ cell: '*', code: 'STATUS_FAILED' }]);
});

test('bootCells: fleet unavailable -> vuoto, no crash', async () => {
  const r = await bootCells({ available: false }, { log: () => {} });
  assert.deepEqual(r, { started: [], skipped: [], failed: [], unconfirmed: [] });
});

test('bootCells: ordine preservato + log chiamato (started/skipped/failed)', async () => {
  const logs = [];
  const fleet = mockFleet(
    [{ cell: 'A', boot: true }, { cell: 'B', boot: true }, { cell: 'C', boot: true }],
    async (id) => {
      if (id === 'B') throw httpError(409, 'dup', { fleetCode: 'SESSION_DUPLICATE' });
      if (id === 'C') throw httpError(500, 'x');
      return { ok: true };
    },
  );
  const r = await bootCells(fleet, { log: (m) => logs.push(m) });
  assert.deepEqual(r.started, ['A']);
  assert.deepEqual(r.failed.map((f) => f.cell), ['B', 'C']);
  assert.ok(logs.some((l) => /started A/.test(l)));
  assert.ok(logs.some((l) => /failed B/.test(l)));
});

test('bootCells: nessuna cella boot:true -> tutto vuoto', async () => {
  const fleet = mockFleet([{ cell: 'A', boot: false }], async () => ({ ok: true }));
  const r = await bootCells(fleet, { log: () => {} });
  assert.deepEqual(r, { started: [], skipped: [], failed: [], unconfirmed: [] });
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
  assert.match(s, /ExecStart=\/usr\/bin\/node \/home\/user\/nexuscrew\/bin\/nexuscrew\.js fleet-boot/);
  assert.match(s, /Environment=PATH=/);
  assert.match(s, /^WorkingDirectory=\/home\/user$/m);
  assert.doesNotMatch(s, /^WorkingDirectory=\/home\/user\/nexuscrew$/m);
  assert.match(s, /WantedBy=default\.target/);
});

test('generateFleetService mac: launchd plist com.mmmbuto.nexuscrew-fleet + ProgramArguments', () => {
  const s = generateFleetService({ ...SVC, platform: 'mac' });
  assert.match(s, /<\?xml/);
  assert.match(s, /<plist version="1\.0">/);
  assert.match(s, /<key>Label<\/key>\s*<string>com\.mmmbuto\.nexuscrew-fleet<\/string>/);
  assert.match(s, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.match(s, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(s, /<string>fleet-boot<\/string>/);
  assert.match(s, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(s, /fleet-boot\.log/);
  assert.match(s, /<key>WorkingDirectory<\/key>\s*<string>\/home\/user<\/string>/);
  assert.doesNotMatch(s, /<key>WorkingDirectory<\/key>\s*<string>\/home\/user\/nexuscrew<\/string>/);
  assert.ok(!s.includes('<home>'));
});

test('generateFleetService termux: boot script + exec fleet-boot + log redirect', () => {
  const s = generateFleetService({ ...SVC, platform: 'termux' });
  assert.match(s, /^#!\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
  assert.match(s, /export PATH=\/data\/data\/com\.termux\/files\/usr\/bin:\$PATH/);
  assert.match(s, /export HOME=\/data\/data\/com\.termux\/files\/home/);
  assert.match(s, /export PREFIX=\/data\/data\/com\.termux\/files\/usr/);
  assert.match(s, /export TMPDIR=\$PREFIX\/tmp/);
  assert.match(s, /export TMUX_TMPDIR=\$PREFIX\/var\/run/);
  assert.match(s, /mkdir -p "\$TMPDIR" "\$TMUX_TMPDIR"/);
  assert.match(s, /^cd -- "\$HOME"$/m);
  assert.doesNotMatch(s, /^cd -- .*nexuscrew/m);
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
  assert.deepEqual(r.units, ['cloud-cell@Dev.service']);
});

// ---------------------------------------------------------------------------
// 4. runFleetBoot come client del daemon (unit, HTTP finto)
// ---------------------------------------------------------------------------

const NODE_ID = 'ab'.repeat(16);

// HTTP finto: risponde per method+path secondo lo script `routes`; registra
// OGNI richiesta (path e body) cosi' i test provano che i POST portano il solo
// target e che non ci sono mai ripetizioni alla cieca.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: u.search, body });
    const hit = routes.find((r) => r.method === method && r.path === u.pathname);
    if (!hit) return { status: 404, json: async () => ({ error: 'not found' }) };
    const out = typeof hit.reply === 'function' ? hit.reply({ body, query: u.searchParams }) : hit.reply;
    if (out instanceof Error) throw out;
    return {
      status: out.status,
      json: out.jsonReject === true
        ? async () => { throw new Error('truncated'); }
        : async () => out.json,
    };
  };
  return { impl: (...a) => impl(...a).catch((e) => { if (e instanceof Error && !(e.routeError)) throw e; throw e; }), calls };
}

function routeConfig(instanceId = NODE_ID) { return { method: 'GET', path: '/api/config', reply: { status: 200, json: { instanceId, version: 'test' } } }; }
function routeStatus(json) { return { method: 'GET', path: '/api/fleet/status', reply: { status: 200, json } }; }
function routeUp(handler) { return { method: 'POST', path: '/api/fleet/up', reply: handler }; }

function bootOpts(fetchFake, extra = {}) {
  return {
    log: () => {},
    cfg: {},
    token: 'token-di-test',
    readNodeId: () => NODE_ID,
    fetchImpl: fetchFake,
    readyBudget: 1500,
    readyTick: 10,
    ...extra,
  };
}

test('client: daemon assente oltre budget -> exit 1, zero POST, zero spawn locali', async () => {
  const netFail = new TypeError('fetch failed');
  const fake = fakeFetch([{ method: 'GET', path: '/api/config', reply: netFail }]);
  const r = await runFleetBoot(bootOpts(fake.impl, {
    // Sulla base questo seam viene usato: il boot partirebbe LOCALE. Il test
    // esige invece il fallimento forte del client: nessun fallback locale.
    selectProvider: async () => { throw new Error('il companion non deve istanziare fleet locali'); },
  }));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'daemon-unreachable');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('client: fleet disabilitata NELLA CONFIG locale -> code 0, esito distinto, zero richieste', async () => {
  const fake = fakeFetch([]);
  const r = await runFleetBoot(bootOpts(fake.impl, { cfg: { fleetEnabled: false } }));
  assert.equal(r.code, 0);
  assert.equal(r.mode, 'disabled');
  assert.equal(fake.calls.length, 0);
});

test('client: daemon che dichiara fleet disabled -> code 0, esito distinto, zero POST', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: false, provider: 'disabled', reason: 'fleet disabilitata' }),
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 0);
  assert.equal(r.mode, 'disabled');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('client: instanceId diverso dal nodo locale -> exit 1 immediato, zero POST', async () => {
  const fake = fakeFetch([routeConfig('ff'.repeat(16))]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'identity-mismatch');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('client: token rifiutato (401) -> exit 1, motivo chiuso auth', async () => {
  const fake = fakeFetch([{ method: 'GET', path: '/api/config', reply: { status: 401, json: { error: 'unauthorized' } } }]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'auth-rejected');
});

test('client: supervision assente oltre budget -> exit 1, zero POST (fail-closed)', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }], supervision: { lease: 'absent', control: 'absent' } }),
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'supervision-absent');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('client: daemon senza campo supervision -> trattato come assente, exit 1', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }] }),
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'supervision-absent');
});

test('client: readiness che matura (starting -> ready) -> boot procede', async () => {
  let stato = 'starting';
  const fake = fakeFetch([
    routeConfig(),
    { method: 'GET', path: '/api/fleet/status', reply: () => ({ status: 200, json: { available: true, cells: [{ cell: 'A', boot: true }], supervision: { lease: stato, control: stato } } }) },
    routeUp(() => ({ status: 200, json: { ok: true } })),
  ]);
  setTimeout(() => { stato = 'ready'; }, 40);
  const r = await runFleetBoot(bootOpts(fake.impl, { readyBudget: 3000, readyTick: 10 }));
  assert.equal(r.code, 0);
  assert.equal(r.mode, 'daemon-client');
  assert.deepEqual(r.summary.started, ['A']);
});

test('client: POST up porta il SOLO target {cell}, mai engine/boot/model', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }], supervision: { lease: 'ready', control: 'ready' } }),
    routeUp(() => ({ status: 200, json: { ok: true } })),
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 0);
  const posts = fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/fleet/up');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { cell: 'A' });
});

test('client: READONLY 403 -> failed -> exit 1 (no short-circuit, entrambe le celle)', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }, { cell: 'B', boot: true }], supervision: { lease: 'ready', control: 'ready' } }),
    routeUp(() => ({ status: 403, json: { error: 'READONLY: up bloccato' } })),
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.summary.failed.length, 2);
});

test('client: risposta persa sul POST -> unconfirmed, exit 1, mai secondo POST, le altre proseguono', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }, { cell: 'B', boot: true }], supervision: { lease: 'ready', control: 'ready' } }),
    routeUp(({ body }) => {
      if (body.cell === 'A') return new TypeError('fetch failed: risposta persa');
      return { status: 200, json: { ok: true } };
    }),
    { method: 'GET', path: '/api/fleet/launch-state', reply: { status: 200, json: { ok: true, classification: 'none', launchId: null, phase: null } } },
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.deepEqual(r.summary.unconfirmed, [{ cell: 'A', code: 'LOST' }]);
  assert.deepEqual(r.summary.started, ['B']);
  const posts = fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/fleet/up');
  assert.deepEqual(posts.map((p) => p.body.cell), ['A', 'B'], 'un solo POST per cella');
});

test('client: lo skip rilegge lo status CORRENTE, non la fotografia della readiness', async () => {
  let letture = 0;
  const fake = fakeFetch([
    routeConfig(),
    { method: 'GET', path: '/api/fleet/status', reply: () => {
      letture += 1;
      // La readiness vede la lease live; OGNI lettura successiva la dichiara
      // scaduta: la prova dello skip deve rileggere, non riusare la fotografia.
      return {
        status: 200,
        json: {
          available: true, supervision: { lease: 'ready', control: 'ready' },
          cells: [{ cell: 'A', boot: true, lease: letture <= 1 ? 'live' : 'expired' }],
        },
      };
    } },
    routeUp(() => ({ status: 409, json: { error: 'sessione già in esecuzione', code: 'SESSION_DUPLICATE' } })),
    { method: 'GET', path: '/api/fleet/launch-state', reply: { status: 200, json: attesaViva({ cell: 'A' }) } },
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1, 'lease scaduta non è uno skip corrente');
  assert.deepEqual(r.summary.skipped, []);
  assert.deepEqual(r.summary.failed, [{ cell: 'A', code: 'SESSION_DUPLICATE' }]);
  assert.ok(letture >= 2, 'lo status è stato riletto dopo il POST');
});

test('client: POST up 200 con corpo illeggibile -> lost, mai un verdetto ricevuto', async () => {
  const c = createBootClient({
    port: 1, token: 't', expectedInstanceId: 'ab'.repeat(16),
    fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('truncated'); } }),
  });
  assert.equal((await c.postUp('Cell')).kind, 'lost', 'corpo 2xx illeggibile = nessun verdetto');
});

test('client: risposta 200 col corpo troncato -> unconfirmed dopo consultazione, exit 1, mai started', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, supervision: { lease: 'ready', control: 'ready' }, cells: [{ cell: 'A', boot: true }] }),
    routeUp(() => ({ status: 200, jsonReject: true })),
    { method: 'GET', path: '/api/fleet/launch-state', reply: { status: 200, json: { ok: true, classification: 'none', launchId: null, phase: null } } },
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.deepEqual(r.summary.started, [], 'mai started dal solo status 2xx col corpo illeggibile');
  assert.deepEqual(r.summary.unconfirmed, [{ cell: 'A', code: 'LOST' }]);
  const posts = fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/fleet/up');
  assert.equal(posts.length, 1, 'nessun secondo POST');
});

// ---------------------------------------------------------------------------
// 5. dispatch glue
// ---------------------------------------------------------------------------

async function runBootDispatch(opts) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const r = dispatch(['fleet-boot'], { exit: (c) => resolve(c), cfg: {}, log: () => {}, token: 'token-di-test', readNodeId: () => NODE_ID, ...opts });
  const code = await done;
  return { code, r };
}

test('dispatch fleet-boot: daemon ok con failed -> exit 1', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }], supervision: { lease: 'ready', control: 'ready' } }),
    routeUp(() => ({ status: 500, json: { error: 'nope' } })),
  ]);
  const { code, r } = await runBootDispatch({ fetchImpl: fake.impl, readyBudget: 1500, readyTick: 10 });
  assert.equal(r.keepAlive, true);
  assert.equal(code, 1);
});

test('dispatch fleet-boot: daemon ok tutto started -> exit 0', async () => {
  const fake = fakeFetch([
    routeConfig(),
    routeStatus({ available: true, cells: [{ cell: 'A', boot: true }, { cell: 'B', boot: true }], supervision: { lease: 'ready', control: 'ready' } }),
    routeUp(() => ({ status: 200, json: { ok: true } })),
  ]);
  const { code } = await runBootDispatch({ fetchImpl: fake.impl, readyBudget: 1500, readyTick: 10 });
  assert.equal(code, 0);
});

test('dispatch fleet-boot: disabled nella config -> exit 0', async () => {
  const { code } = await runBootDispatch({ cfg: { fleetEnabled: false } });
  assert.equal(code, 0);
});

test('dispatch fleet-boot Termux entra in HOME prima di inizializzare Fleet', async () => {
  let cwd = null;
  const { code } = await runBootDispatch({
    platform: 'termux',
    home: '/stable/termux/home',
    chdirImpl: (target) => { cwd = target; },
    cfg: { fleetEnabled: false },
  });
  assert.equal(code, 0);
  assert.equal(cwd, '/stable/termux/home');
});
