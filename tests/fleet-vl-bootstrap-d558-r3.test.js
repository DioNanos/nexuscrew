'use strict';
// D-558 FIX1b — R3 dell'audit, con la regola PER AVVIO di FIX1a: esito
// PERSISTENTE della claim per avvio (pending/submitted/failed/uncertain),
// motivo (notReady compreso) nel risultato di up(), skip normale distinto dal
// primo prompt non consegnato in questo avvio. Runtime REALE con fixture
// fleet-vl-session (fake vl + fake tmux a stato vero + broker che cattura il
// payload); la consegna vera è del supervisore, provato qui con seam sul
// trasporto ma con la claim VERA su disco. Nessun tmux/vl/cella vera: HOME
// isolata in /tmp.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');
const {
  settleVlBootstrapClaim, vlClaimOutcomeFor, CLAIM_STATES,
} = require('../lib/fleet/vl-bootstrap-claim.js');
const cellExec = require('../lib/fleet/cell-exec.js');

const SESSIONE = 'cloud-CellaProva';
const PROMPT = 'Leggi CLAUDE.md e parti';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558r3-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaProva');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  // Binario finto QUALIFICATO peer/stop con host VERO: la tuple dichiarata in
  // `host status` viene letta da /proc del pid vivo nel pidfile, così al down
  // il runtime osserva in /proc la STESSA identità che ha registrato all'up.
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  const vllog = path.join(root, 'vl.log');
  fs.writeFileSync(hostpid, '0\n');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid, vllog }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  // Report @nc_delivery del finto supervisore, PARAMETRIZZATO da file: il
  // runtime vero legge da qui (submitted di default, come un supervisore che
  // ha consegnato). I test lo cambiano per not-ready e skip.
  const deliveryPath = path.join(root, 'delivery.txt');
  fs.writeFileSync(deliveryPath, 'submitted');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      const r = spawnSync(process.execPath,
        [__filename, '-S', process.argv[3] || 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}

const STATO = ${JSON.stringify(statoPath)};
const DELIVERY = ${JSON.stringify(deliveryPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  // La nascita dell'host accompagna la sessione: come la TUI vera, che l'host
  // lo fa nascere all'avvio, ogni new-session fa nascere un host nuovo (il
  // vecchio pid, se ancora vivo, viene spento per pid esatto dall'helper).
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('@nc_delivery')) {
    try { process.stdout.write(fs.readFileSync(DELIVERY, 'utf8').trim() + '\\n'); } catch (_) { process.stdout.write('\\n'); }
    process.exit(0);
  }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  if (mia) fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  process.exit(mia && vive().includes(${JSON.stringify(SESSIONE)}) ? 0 : 1);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: PROMPT }],
  });

  const tickets = [];
  let adesso = 0;
  const clock = { now: () => adesso, advance: (ms) => { adesso += ms; } };
  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => {},
    close: async () => {},
  };
  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    now: clock.now, monotonicNow: clock.now,
    // Owner hex32 della tuple attestata all'up: con `local` l'up e' rifiutato.
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
  };
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    try {
      const p = Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0;
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, home, tickets, clock, cfgBase,
    delivery: deliveryPath,
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

// Seam del supervisore: il trasporto è l'unico punto iniettabile, la claim è
// VERA (su disco, presa dal payload reale del broker).
function supervisorSeams(deliverResult) {
  const calls = { deliver: [], options: [] };
  const live = new Set();
  return {
    calls,
    seams: {
      setTimeout: (fn, ms) => {
        const h = {};
        live.add(h);
        setTimeout(() => { if (live.delete(h)) fn(); }, Math.min(ms, 2));
        return h;
      },
      clearTimeout: (h) => { live.delete(h); },
      tmuxExec: async (bin, args) => {
        if (args[0] === 'set-option') calls.options.push(args[args.length - 1]);
        return { err: null, stdout: '', stderr: '' };
      },
      deliverBootstrapPrompt: async (opts) => {
        calls.deliver.push(opts);
        return deliverResult;
      },
    },
  };
}

const SUBMITTED = { delivered: true, state: 'submitted', notReady: '', attempts: 1, reason: 'submitted' };

test('runtime reale: submitted — la claim per avvio si settle in submitted e non si riscrive', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(res.prompt.state, 'submitted');
  assert.deepEqual(res.vlBootstrap, { state: 'submitted' }, 'esito nel risultato di up()');
  const rp = w.tickets[0].restartPrompt;
  const s = supervisorSeams(SUBMITTED);
  await cellExec.startGenerationPrompt({ ...rp }, 0, { exited: false }, s.seams).settled;
  assert.equal(s.calls.deliver.length, 1);
  const claim = JSON.parse(fs.readFileSync(rp.vlBootstrap.claimPath, 'utf8'));
  assert.equal(claim.state, 'submitted', 'submitted = paste+Enter riusciti, persistito');
  assert.equal(claim.detail, 'submitted');
  // L'esito pubblicato di questo avvio non si riscrive (fail-safe, no downgrade).
  const again = settleVlBootstrapClaim({ claimPath: rp.vlBootstrap.claimPath, state: 'failed', detail: 'failed-pre-paste' });
  assert.equal(again.updated, false);
  assert.equal(JSON.parse(fs.readFileSync(rp.vlBootstrap.claimPath, 'utf8')).state, 'submitted');
});

test('runtime reale: errore di trasporto certo — la claim si settle in failed', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await fleet.up('CellaProva');
  const rp = w.tickets[0].restartPrompt;
  const s = supervisorSeams({ delivered: false, state: 'failed-pre-paste', notReady: '', attempts: 2, reason: 'failed-pre-paste' });
  await cellExec.startGenerationPrompt({ ...rp }, 0, { exited: false }, s.seams).settled;
  assert.equal(s.calls.deliver.length, 1);
  const claim = JSON.parse(fs.readFileSync(rp.vlBootstrap.claimPath, 'utf8'));
  assert.equal(claim.state, 'failed', 'fallimento certo prima del paste');
  assert.equal(claim.detail, 'failed-pre-paste');
});

test('runtime reale: paste incerto — claim uncertain e NESSUN retry nello stesso avvio', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await fleet.up('CellaProva');
  const rp = w.tickets[0].restartPrompt;
  const s = supervisorSeams({ delivered: false, state: 'delivery-unknown', notReady: '', attempts: 1, reason: 'delivery-unknown' });
  await cellExec.startGenerationPrompt({ ...rp }, 0, { exited: false }, s.seams).settled;
  assert.equal(s.calls.deliver.length, 1, 'at-most-once: nessun secondo paste dopo un esito incerto');
  assert.ok(s.calls.options.includes('delivery-unknown'));
  const claim = JSON.parse(fs.readFileSync(rp.vlBootstrap.claimPath, 'utf8'));
  assert.equal(claim.state, 'uncertain', 'paste forse avvenuto');
  assert.equal(claim.detail, 'delivery-unknown');
});

test('runtime reale: TUI non pronta — motivo notReady NEL risultato di up()', async (t) => {
  const w = mondo(t);
  fs.writeFileSync(w.delivery, 'skipped-not-ready:not-ready-consent');
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(res.prompt.state, 'skipped-not-ready');
  assert.equal(res.prompt.notReady, 'not-ready-consent', 'il motivo non si scarta più');
  assert.deepEqual(res.vlBootstrap,
    { state: 'failed', reason: 'skipped-not-ready', notReady: 'not-ready-consent' });
});

test('runtime reale: skip NORMALE distinto dal primo prompt non consegnato in questo avvio', async (t) => {
  const w = mondo(t);
  fs.writeFileSync(w.delivery, 'skipped-vl-bootstrap:generation');
  let fleet = await w.fleet();
  let res = await fleet.up('CellaProva');
  assert.deepEqual(res.vlBootstrap, { state: 'skipped', reason: 'generation' },
    'respawn/riattacco nello stesso avvio: skip normale, nessun avviso');
  // Nuovo avvio, claim non ottenibile: il primo prompt NON è stato consegnato.
  await fleet.down('CellaProva');
  fs.writeFileSync(w.delivery, 'skipped-vl-bootstrap:claim-unavailable');
  res = await fleet.up('CellaProva');
  assert.deepEqual(res.vlBootstrap, { state: 'not-delivered', reason: 'claim-unavailable' });
});

test('claim: vocabulary bounded e settle fail-safe', () => {
  assert.deepEqual([...CLAIM_STATES], ['pending', 'submitted', 'failed', 'uncertain']);
  assert.equal(vlClaimOutcomeFor('submitted'), 'submitted');
  assert.equal(vlClaimOutcomeFor('delivery-unknown'), 'uncertain');
  assert.equal(vlClaimOutcomeFor('staged-not-submitted'), 'uncertain');
  assert.equal(vlClaimOutcomeFor('failed-pre-paste'), 'failed');
  assert.equal(vlClaimOutcomeFor('skipped-not-ready'), 'failed');
  assert.equal(vlClaimOutcomeFor('cancelled'), null, 'niente esito del supervisore: resta pending (si legge incerto)');
  assert.equal(vlClaimOutcomeFor('report-timeout'), null);
  // Claim assente: non si inventa un esito e non si crea nessun file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558r3-unit-'));
  const missing = path.join(dir, 'bootstrap-0000000000000000.json');
  const r = settleVlBootstrapClaim({ claimPath: missing, state: 'failed', detail: 'failed-pre-paste' });
  assert.equal(r.updated, false);
  assert.equal(fs.existsSync(missing), false, 'mai creare o cancellare la claim nel settle');
  // Stato non bounded rifiutato (payload remoto/federato incluso).
  const pending = path.join(dir, 'bootstrap-0000000000000001.json');
  fs.writeFileSync(pending, JSON.stringify({ version: 2, state: 'pending' }));
  assert.equal(settleVlBootstrapClaim({ claimPath: pending, state: 'evil' }).updated, false);
  assert.equal(settleVlBootstrapClaim({ claimPath: pending, state: 'pending' }).updated, false,
    'pending non è un esito: resta pending');
  fs.rmSync(dir, { recursive: true, force: true });
});
