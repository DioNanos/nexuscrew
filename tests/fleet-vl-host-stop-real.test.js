'use strict';
// Lo stop con il VL VERO: `vl server --foreground` come host reale,
// `fermaHost` sul binario pinnato, `host status` e `internal host-stop` reali.
//
// Il binario non e' di questo repo: lo dà NC_VL_REAL_BIN (costruito dal commit di
// VL che si qualifica, via w.sh, con la sua provenienza dichiarata). Senza, il
// test si salta e DICE perche': non e' una prova che passi in silenzio. Se c'e'
// NC_VL_REAL_BIN_SHA256 il binario deve averlo.
//
// L'isolamento lo passa il TEST: il runtime non lo calcola ancora (c'e' solo il
// giudizio puro, nessuna osservazione dell'host). Qui si prova il modulo, non il
// cammino del runtime.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const host = require('../lib/fleet/vl-host-stop.js');

const REALE = process.env.NC_VL_REAL_BIN || '';
const SHA_ATTESO = process.env.NC_VL_REAL_BIN_SHA256 || '';
const SALTA = REALE ? false : 'NC_VL_REAL_BIN non impostato: nessun VL vero con cui provare lo stop';

function mondo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-realvl-'));
  fs.chmodSync(base, 0o700);
  const dirs = {};
  for (const d of ['home', 'state', 'data', 'config', 'runtime']) {
    dirs[d] = path.join(base, d);
    fs.mkdirSync(dirs[d], { mode: 0o700 });
  }
  fs.mkdirSync(path.join(dirs.config, 'vl'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(dirs.config, 'vl', 'config.toml'),
    '[profiles.p]\nprovider = "openai-compat"\nbase_url = "http://127.0.0.1:9"\nmodel = "m"\n',
  );
  const root = path.join(base, 'root');
  const bin = path.join(base, 'bin', 'vl');
  fs.mkdirSync(path.dirname(bin), { mode: 0o700 });
  fs.copyFileSync(REALE, bin);
  fs.chmodSync(bin, 0o755);
  return { base, dirs, root, bin };
}

function envHost(m) {
  return {
    HOME: m.dirs.home,
    XDG_STATE_HOME: m.dirs.state,
    XDG_DATA_HOME: m.dirs.data,
    XDG_CONFIG_HOME: m.dirs.config,
    XDG_RUNTIME_DIR: m.dirs.runtime,
    PATH: '/usr/bin:/bin',
  };
}

function recordDi(m) {
  return {
    launchId: 'cd'.repeat(8),
    vlBin: m.bin,
    vlBinSha256: host.sha256File(m.bin),
    XDG_STATE_HOME: m.dirs.state,
    XDG_DATA_HOME: m.dirs.data,
    XDG_CONFIG_HOME: m.dirs.config,
    HOME: m.dirs.home,
    uid: process.getuid(),
    serverRoot: m.root,
    ts: 1,
  };
}

// Lo status con il binario vero, fuori da fermaHost: per guardare senza passare
// dal modulo che si prova.
function statoVero(m, bin) {
  const r = spawnSync(bin || m.bin, ['host', 'status', '--json', '--server-root', m.root], {
    env: envHost(m), encoding: 'utf8', timeout: 10000,
  });
  return JSON.parse(r.stdout);
}

async function avviaHost(m) {
  const figlio = spawn(m.bin, ['server', '--foreground', '--server-root', m.root, '--profile', 'p'], {
    env: envHost(m), stdio: ['ignore', 'ignore', 'ignore'],
  });
  const uscito = new Promise((resolve) => figlio.once('exit', (code, sig) => resolve({ code, sig })));
  let fine = false;
  uscito.then(() => { fine = true; });
  const limite = Date.now() + 15000;
  for (;;) {
    if (fine) throw new Error('il host vero e uscito prima di essere vivo');
    if (Date.now() > limite) { figlio.kill('SIGKILL'); throw new Error('il host vero non e diventato vivo'); }
    let s = null;
    try { s = statoVero(m); } catch (_) { s = null; }
    if (s && s.state === 'live') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { figlio, uscito };
}

function seminaSessione(m) {
  const dir = path.join(m.root, 'sessions', 'default', '.vl', 'context');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'live.json');
  const contenuto = Buffer.from('[{"role":"user","content":"ciao"}]');
  fs.writeFileSync(file, contenuto);
  return { file, contenuto };
}

function archivi(m) {
  try {
    return fs.readdirSync(path.join(m.root, 'sessions')).filter((n) => n.startsWith('archive-')).length;
  } catch (_) { return 0; }
}

async function conHost(fn) {
  const m = mondo();
  let h = null;
  try {
    h = await avviaHost(m);
    await fn(m, h);
  } finally {
    if (h && h.figlio.exitCode === null && h.figlio.signalCode === null) h.figlio.kill('SIGKILL');
    fs.rmSync(m.base, { recursive: true, force: true });
  }
}

test('VL vero: il binario e quello dichiarato e conosce lo stop', { skip: SALTA }, () => {
  if (SHA_ATTESO) assert.equal(host.sha256File(REALE), SHA_ATTESO, 'il binario non e quello dichiarato');
  const m = mondo();
  try {
    const s = statoVero(m);
    assert.equal(s.state, 'none');
    assert.ok(Array.isArray(s.capabilities) && s.capabilities.includes('host_stop_v1'), JSON.stringify(s));
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});

test('VL vero: status → internal host-stop → status none, con la sessione intatta', { skip: SALTA }, async () => {
  await conHost(async (m, h) => {
    const sessione = seminaSessione(m);
    const pin = host.pinBinario({ source: m.bin, home: m.dirs.home, owner: 'local', cellId: 'Cella' });
    assert.equal(pin.ok, true);
    const rec = recordDi(m);
    // Lo status vero, prima: un host vivo che dichiara la capacita'.
    const prima = statoVero(m, pin.path);
    assert.equal(prima.state, 'live');
    assert.ok(prima.capabilities.includes('host_stop_v1'));

    const esito = await host.fermaHost({
      record: rec, bin: pin.path, budgetMs: 30000, monoNow: () => Date.now(), isolamento: 'isolato',
    });
    assert.equal(esito.outcome, 'host-stopped-clean', JSON.stringify(esito));
    assert.equal(esito.via, 'internal');
    assert.equal(esito.spawned, 3, 'status, stop, status');

    // L'host e' davvero uscito, e lo status vero dice none.
    const u = await Promise.race([h.uscito, new Promise((r) => setTimeout(() => r(null), 10000))]);
    assert.ok(u, 'il processo host non e uscito');
    assert.equal(statoVero(m, pin.path).state, 'none');
    // Lo stop non e' un reset: la conversazione e' com'era e nulla e' archiviato.
    assert.deepEqual(fs.readFileSync(sessione.file), sessione.contenuto);
    assert.equal(archivi(m), 0);

    // E ora che e' fermo: nessun bisogno di uno stop.
    const dopo = await host.fermaHost({
      record: rec, bin: pin.path, budgetMs: 30000, monoNow: () => Date.now(), isolamento: 'isolato',
    });
    assert.equal(dopo.outcome, 'host-already-stopped');
    assert.equal(dopo.spawned, 1);
  });
});

test('VL vero: la capacita non autorizza, senza isolamento l\'host vivo non si tocca', { skip: SALTA }, async () => {
  await conHost(async (m, h) => {
    const rec = recordDi(m);
    for (const isolamento of [undefined, 'ignoto']) {
      const esito = await host.fermaHost({
        record: rec, bin: m.bin, budgetMs: 30000, monoNow: () => Date.now(), isolamento,
      });
      assert.equal(esito.outcome, 'host-stop-failed');
      assert.equal(esito.code, 'IDENTITY_UNKNOWN');
      assert.equal(esito.spawned, 1, 'solo lo status');
    }
    // L'host e' ancora li', vivo.
    assert.equal(h.figlio.exitCode, null);
    assert.equal(statoVero(m).state, 'live');
  });
});
