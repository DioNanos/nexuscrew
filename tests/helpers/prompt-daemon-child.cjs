'use strict';
// Demone (lease manager + runtime) in un processo distinto, per le prove di
// restart end-to-end dello strato 2c. Ruolo A: apre la connessione iniziale del
// supervisore. Ruolo B: parte DOPO la morte di A sullo stesso root (boot sul
// root esistente, nessun runtime/osservatore precedente). Si pilota da stdin:
//   status | quit    — risponde su stdout con una riga JSON.
//   argv[2] = JSON { role, leaseHome, defsPath, tmuxBin, home, filesRoot, cellId }
const net = require('node:net');
const readline = require('node:readline');
const { createLeaseManager } = require('../../lib/fleet/cell-lease-server.js');
const { createBuiltinRuntime } = require('../../lib/fleet/runtime.js');
const { loadDefinitions } = require('../../lib/fleet/definitions.js');
const { createDiagnostics } = require('../../lib/diagnostics/store.js');

const cfg = JSON.parse(process.argv[2]);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

(async () => {
  const mgr = createLeaseManager({ home: cfg.leaseHome, log: () => {} }, { now: () => Date.now() });
  const diagnostics = createDiagnostics();
  let info = null;
  if (cfg.role === 'A') {
    info = await mgr.track(cfg.cellId);
    const server = net.createServer((sock) => {
      mgr.attachInitial(cfg.cellId, sock, { generation: 0 });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    out({ ev: 'listening', port: server.address().port, stablePath: info.stablePath, launchEpoch: info.launchEpoch });
  } else {
    await mgr.boot();
    out({ ev: 'booted' });
  }
  const rt = createBuiltinRuntime({
    cfg: { filesRoot: cfg.filesRoot, activityHooks: false, log: () => {}, env: {}, diagnostics },
    home: cfg.home, defsPath: cfg.defsPath, tmuxBin: cfg.tmuxBin, readonly: () => false,
    launchBroker: { issue: async () => ({}), revoke: async () => {}, close: async () => {} },
    leaseManager: mgr, boot: loadDefinitions(cfg.defsPath),
  });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (riga) => {
    const cmd = riga.trim();
    if (cmd === 'status') {
      let cella = null;
      try { cella = (await rt.status({})).cells[0]; } catch (_) { cella = null; }
      out({
        ev: 'status',
        promptDelivery: cella && cella.promptDelivery ? cella.promptDelivery : null,
        promptMcp: cella && cella.promptMcp ? cella.promptMcp : null,
        lease: mgr.status(cfg.cellId).state,
        armato: mgr.controlArmato(cfg.cellId),
        eventi: diagnostics.logs({ limit: 200 }).records.filter((r) => r.code === 'PROMPT_DELIVERY_TERMINAL').length,
      });
    } else if (cmd === 'quit') {
      process.exit(0);
    }
  });
})().catch((e) => { process.stderr.write(`daemon child: ${e && e.message}\n`); process.exit(1); });
