'use strict';
// D-558 FIX1a — consegna del prompt a OGNI avvio, provata sul runtime REALE.
// Fixture fleet-vl-session (fake vl + fake tmux a stato vero + broker che
// cattura il payload): la decisione per avvio attraversa preflight, riserva
// della root, claim e payload. Il paste è del supervisore (single-owner,
// provato con seam in fleet-vl-bootstrap-d558.test.js): qui "un paste" è
// l'incarico che il runtime consegna al supervisore — UN payload con
// eligible:true per avvio — e il report del supervisore torna al chiamante.
// Nessun tmux/vl/cella vera: HOME isolata in /tmp.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');
const cellExec = require('../lib/fleet/cell-exec.js');

const SESSIONE = 'cloud-CellaProva';
const PROMPT = 'Leggi CLAUDE.md e parti';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558rt-'));
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
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  // Fake tmux a stato vero (come fleet-vl-session.test.js) con in più la
  // risposta al report @nc_delivery: il supervisore vero non gira qui, e il
  // report 'submitted' sblocca up() senza attendere il timeout (la consegna
  // del paste al gen0 è provata con seam nell'altra suite).
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
  if (fmt.includes('@nc_delivery')) { process.stdout.write('submitted\\n'); process.exit(0); }
  if ((typeof fmt === 'string' ? fmt : process.argv.join(' ')).includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
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
  const base = () => vlCellBaseDir(home, OWNER_INSTANCE_ID, 'CellaProva');
  const claimFiles = () => {
    const dir = path.join(base(), 'nc');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('bootstrap-')) : [];
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
    root, home, tickets, clock, cfgBase, base, claimFiles,
    hostRoot: path.join(base(), 'state', 'vl', 'host-v1'),
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

function supervisorSeams() {
  const calls = { deliver: [], options: [] };
  const live = new Set();
  return {
    calls,
    seams: {
      // Supervised-delivery fixture: the prompt-outcome channel is required
      // (fresh ephemeral dir per seams instance).
      promptOutcome: {
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-fx-')),
        launchId: '7f8091a2b3c4d5e6',
      },
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
        return { delivered: true, state: 'submitted', notReady: '', attempts: 1, reason: 'submitted' };
      },
    },
  };
}

test('runtime reale: host GIA\' ESISTENTE — up consegna il prompt, eligible per avvio, claim su disco', async (t) => {
  const w = mondo(t);
  // la root canonica dell'host esiste GIÀ (cella con storia): nessuno skip
  fs.mkdirSync(path.join(w.hostRoot, 'sessions'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w.hostRoot, 'sessions', 'default'), '');
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(res.prompt.state, 'submitted', 'report del supervisore letto dal runtime');
  const vb = w.tickets[0].restartPrompt.vlBootstrap;
  assert.equal(vb.eligible, true, 'host esistente: idoneo comunque (requisito DAG)');
  assert.equal(vb.reason, 'launch');
  assert.ok(typeof vb.claimPath === 'string' && vb.claimPath.includes(path.join('.nexuscrew', 'vl-cells')));
  assert.ok(!vb.claimPath.includes(path.join('state', 'vl', 'host-v1')), 'claim mai dentro i file di VL');
  assert.equal(w.tickets[0].restartPrompt.prompt, PROMPT, 'il primo turno utente è cell.prompt');
  assert.equal(w.tickets[0].restartPrompt.client, 'vl');
  assert.equal(w.claimFiles().length, 1, 'una claim per QUESTO avvio');
});

test('runtime reale: stop/start — un paste NUOVO per il NUOVO avvio; la claim del primo resta', async (t) => {
  const w = mondo(t);
  fs.mkdirSync(w.hostRoot, { recursive: true, mode: 0o700 });
  const fleet = await w.fleet();
  await fleet.up('CellaProva');
  await fleet.down('CellaProva');
  const res2 = await fleet.up('CellaProva');
  assert.equal(res2.ok, true, 'restart immediato: cooldown 0');
  assert.equal(w.tickets.length, 2);
  assert.equal(w.tickets[0].restartPrompt.vlBootstrap.eligible, true);
  assert.equal(w.tickets[1].restartPrompt.vlBootstrap.eligible, true, 'nuovo avvio: nuovo incarico di paste');
  assert.notEqual(w.tickets[0].restartPrompt.vlBootstrap.claimPath, w.tickets[1].restartPrompt.vlBootstrap.claimPath,
    'claim distinte per avvii distinti');
  assert.equal(w.claimFiles().length, 2, 'una claim per avvio: due avvii, due record');
});

test('runtime reale: respawn generation > 0 e riattacco — il PAYLOAD reale non riconsegna mai', async (t) => {
  const w = mondo(t);
  fs.mkdirSync(w.hostRoot, { recursive: true, mode: 0o700 });
  const fleet = await w.fleet();
  await fleet.up('CellaProva');
  // Il payload catturato dal broker è quello che il supervisore riceve: al
  // respawn (generation > 0) zero paste, skip esplicito; alla generation 0
  // dello stesso avvio UNA consegna (il legame payload reale -> guardia).
  const rp = w.tickets[0].restartPrompt;
  const s0 = supervisorSeams();
  const ctl0 = cellExec.startGenerationPrompt({ ...rp }, 0, { exited: false }, s0.seams);
  await ctl0.settled;
  assert.equal(s0.calls.deliver.length, 1, 'generation 0 di questo avvio: un paste');
  const s1 = supervisorSeams();
  const ctl1 = cellExec.startGenerationPrompt({ ...rp }, 1, { exited: false }, s1.seams);
  await ctl1.settled;
  assert.equal(s1.calls.deliver.length, 0, 'respawn/riattacco: zero paste');
  assert.ok(s1.calls.options.includes('skipped-vl-bootstrap:generation'));
});

test('runtime reale: due up concorrenti — un solo vincitore, UN solo incarico di paste', async (t) => {
  const w = mondo(t);
  fs.mkdirSync(w.hostRoot, { recursive: true, mode: 0o700 });
  const fleet = await w.fleet();
  const esiti = await Promise.allSettled([fleet.up('CellaProva'), fleet.up('CellaProva')]);
  assert.equal(esiti.filter((e) => e.status === 'fulfilled').length, 1, 'un solo vincitore');
  const persi = esiti.filter((e) => e.status === 'rejected');
  assert.equal(persi.length, 1);
  assert.equal(persi[0].reason.fleetCode, 'SESSION_DUPLICATE', 'il perdente è serializzato in preflight');
  assert.equal(w.tickets.length, 1, 'un solo payload: un solo paste per l\'avvio');
  assert.equal(w.tickets[0].restartPrompt.vlBootstrap.eligible, true);
  assert.equal(w.claimFiles().length, 1);
});

test('runtime reale: richiesta di SESSIONE NUOVA — anche questa è un avvio, un paste', async (t) => {
  const w = mondo(t);
  fs.mkdirSync(w.hostRoot, { recursive: true, mode: 0o700 });
  const fleet = await w.fleet();
  const req = await fleet.vlNewSession('CellaProva');
  assert.equal(req.ok, true);
  const res = await fleet.up('CellaProva');
  assert.equal(res.vlNewSession, true, 'la rotazione viaggia nel risultato');
  assert.equal(w.tickets[0].vlNewSession, true, 'e nel payload');
  assert.equal(w.tickets[0].restartPrompt.vlBootstrap.eligible, true, 'sessione nuova = avvio = un paste');
  assert.equal(w.tickets[0].restartPrompt.vlBootstrap.reason, 'launch');
  assert.equal(w.claimFiles().length, 1);
});
