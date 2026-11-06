'use strict';
// Primo up di una cella VL che non e' mai stata lanciata. Il binario di lancio
// e' il client TUI, con questo sha e non un altro. La build headless non apre
// il layout. Binario mancante o diverso: il test fallisce, non si salta.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { radiceServer } = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { OWNER_INSTANCE_ID } = require('./helpers/vl-attestato.js');
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));

// Il binario pinnato e' il client TUI: la build headless esce subito e non
// apre il layout. Assente = fallimento, mai uno skip.
const REALE = process.env.NEXUSCREW_VL_REAL_BIN || '';
// VL 0.4.2, build x86_64 completa con TUI (release): il client delle celle VL.
const SHA_LANCIO = '52a6862d5b01607ab3988df56aa10a59c1e051ae22a7e1ca92d5af64866a1fc9';
const TMUX = '/usr/bin/tmux';
const LIVE = 6083;
const PROMPT = 'Leggi CLAUDE.md e parti';

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('VL vero: primo up di una cella mai lanciata, layout del binario, un prompt', async (t) => {
  assert.ok(REALE && fs.existsSync(REALE) && fs.statSync(REALE).isFile(),
    'NEXUSCREW_VL_REAL_BIN assente: il primo up non si salta');
  assert.equal(sha256(REALE), SHA_LANCIO, 'il binario di lancio non e\' il client TUI atteso');
  assert.ok(fs.existsSync(TMUX), 'tmux di sistema assente');

  const umaskPrima = process.umask(0o022);
  const livePrima = vivo(LIVE);
  const envPrima = {
    HOME: process.env.HOME,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TMUX: process.env.TMUX,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    TMPDIR: process.env.TMPDIR,
    LC_CTYPE: process.env.LC_CTYPE,
  };
  const root = fs.mkdtempSync('/tmp/nc-s6h-up-');
  const tmuxd = fs.mkdtempSync('/tmp/nc-s6h-m-');
  const rt = fs.mkdtempSync('/tmp/nc-s6h-rt-');
  fs.chmodSync(root, 0o700);
  fs.chmodSync(tmuxd, 0o700);
  fs.chmodSync(rt, 0o700);
  const home = root;
  const cwd = path.join(home, 'Mai');
  const cwdB = path.join(home, 'Ctl');
  fs.mkdirSync(cwd, { mode: 0o700 });
  fs.mkdirSync(cwdB, { mode: 0o700 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, '.nexuscrew'), 0o700);
  fs.chmodSync(path.join(home, '.nexuscrew', 'run'), 0o700);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });

  const richieste = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      richieste.push(req.url);
      if (String(req.url).includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"index":0}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const catalogo = path.join(home, 'catalogo.toml');
  fs.writeFileSync(catalogo, [
    'default_profile = "mock"',
    '',
    '[profiles.mock]',
    'provider = "openai-compat"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'model = "mock"',
    '',
  ].join('\n'), { mode: 0o600 });

  const hostRoot = radiceServer(home, OWNER_INSTANCE_ID, 'Mai');
  const baseB = vlCellBaseDir(home, OWNER_INSTANCE_ID, 'Ctl');
  fs.mkdirSync(baseB, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, '.nexuscrew'), 0o700);
  fs.chmodSync(path.join(home, '.nexuscrew', 'vl-cells'), 0o700);
  fs.chmodSync(baseB, 0o700);
  const marker = path.join(baseB, 'controllo');
  fs.writeFileSync(marker, 'intatto\n', { mode: 0o600 });
  const markerHash = sha256(marker);
  const marca = path.join(root, 'spawn-root.txt');
  const tmuxBin = path.join(root, 'tmux-wrap.cjs');
  fs.writeFileSync(tmuxBin, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "new-session" ]; then
    if [ -e ${JSON.stringify(hostRoot)} ] || [ -L ${JSON.stringify(hostRoot)} ]; then
      printf 'presente\\n' >> ${JSON.stringify(marca)}
    else
      printf 'assente\\n' >> ${JSON.stringify(marca)}
    fi
    break
  fi
done
exec ${TMUX} "$@"
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  process.env.HOME = home;
  process.env.TMUX_TMPDIR = tmuxd;
  process.env.XDG_RUNTIME_DIR = rt;
  process.env.TMPDIR = rt;
  process.env.LC_CTYPE = 'C.UTF-8';
  delete process.env.TMUX;

  const capPrima = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('nc-vl-cap-')));
  assert.equal(fs.existsSync(hostRoot), false, 'host-v1 non c\'e\' prima dell\'up');
  assert.ok(!sharedTmuxSocketPath().startsWith('/tmp/tmux-'), 'il socket non e\' quello della flotta');

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: {
        client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard',
        vlProfile: 'mock', vlBinary: REALE, vlConfigFile: catalogo,
      },
    }],
    cells: [
      { id: 'Mai', tmuxSession: 'cloud-Mai', cwd, engine: 'vl.native', boot: false, prompt: PROMPT },
      { id: 'Ctl', tmuxSession: 'cloud-Ctl', cwd: cwdB, engine: 'vl.native', boot: false, prompt: PROMPT },
    ],
  });
  const tickets = [];
  const broker = createLaunchBroker({ home });
  const fleet = await createBuiltinFleet({
    home, fleetDefsPath: defsPath, tmuxBin,
    launchBroker: {
      issue: async (payload) => {
        tickets.push(payload);
        return broker.issue(payload);
      },
      revoke: async (nonce) => broker.revoke(nonce),
      close: async () => broker.close(),
    },
    platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    cellLeaseEnabled: true,
    now: () => Date.now(), monotonicNow: () => Date.now(),
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
  });

  let serverPid = null;
  t.after(async () => {
    try { await fleet.down('Mai'); } catch (_) { /* gia' giu' */ }
    // Cleanup anche sul rosso: se il test fallisce prima del down resterebbe un
    // host VL orfano. Dopo il down del fleet si ferma comunque l'host sul server
    // root di QUESTO test (best-effort, tetto 10 s, solo il root del test).
    try {
      if (fs.existsSync(hostRoot)) {
        spawnSync(REALE, ['shutdown', '--server-root', hostRoot], {
          encoding: 'utf8', timeout: 10000, shell: false,
          env: { HOME: home, PATH: '/usr/bin:/bin', LC_CTYPE: 'C.UTF-8' },
        });
      }
    } catch (_) { /* nessun host da fermare */ }
    try { await fleet.close(); } catch (_) { /* chiuso */ }
    try { await broker.close(); } catch (_) { /* chiuso */ }
    server.close();
    try {
      const pidOut = spawnSync(TMUX, ['display-message', '-p', '#{pid}'], {
        encoding: 'utf8', timeout: 3000,
        env: { ...process.env, TMUX_TMPDIR: tmuxd, TMUX: '' },
      });
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) { /* nessun server */ }
    if (serverPid && serverPid !== LIVE) {
      spawnSync(TMUX, ['kill-server'], {
        timeout: 3000, env: { ...process.env, TMUX_TMPDIR: tmuxd, TMUX: '' },
      });
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) { /* gia' uscito */ }
      verificaUscitaServer(spawnSync, serverPid);
    }
    for (const [k, v] of Object.entries(envPrima)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.umask(umaskPrima);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmuxd, { recursive: true, force: true });
    fs.rmSync(rt, { recursive: true, force: true });
  });

  // Diagnostica del client della cella (solo testo, nessun segreto): dopo l'up e
  // ogni 2 s fino al timeout si registra lo stato del tmux isolato del test, il
  // pane se esiste e cio' che il runtime e NexusCrew conservano del lancio
  // (launch-state, record del lancio, file di attivita' della sessione).
  const fotografie = [];
  const tmuxTest = (args) => spawnSync(TMUX, args, {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: tmuxd, TMUX: '' },
  });
  const ultime = (testo, n = 12) => String(testo || '').split('\n').slice(-n).join('\n').slice(0, 1500);
  const leggiPiccolo = (file) => {
    try { return fs.readFileSync(file, 'utf8').slice(0, 2000); } catch (e) { return `<${e.code || 'illeggibile'}>`; }
  };
  const fotografa = async (etichetta) => {
    const f = { etichetta, t: Date.now() };
    const ls = tmuxTest(['list-sessions', '-F', '#{session_name} windows=#{session_windows}']);
    f.sessioni = `exit ${ls.status}: ${String(ls.stdout || ls.stderr || '').trim().slice(0, 600)}`;
    const lp = tmuxTest(['list-panes', '-a', '-F', '#{session_name} pane=#{pane_id} dead=#{pane_dead} status=#{pane_dead_status} cmd=#{pane_current_command}']);
    f.panes = `exit ${lp.status}: ${String(lp.stdout || lp.stderr || '').trim().slice(0, 600)}`;
    const cap = tmuxTest(['capture-pane', '-p', '-t', '=cloud-Mai']);
    f.pane = cap.status === 0 ? ultime(cap.stdout, 30) : `<assente: ${String(cap.stderr || '').trim().slice(0, 120)}>`;
    try { f.launchState = JSON.stringify(await fleet.launchState('Mai')).slice(0, 1500); } catch (e) { f.launchState = `<errore ${String((e && e.message) || e).slice(0, 200)}>`; }
    f.recordLancio = leggiPiccolo(path.join(home, 'NexusFiles', 'launch-targets', 'cloud-Mai.json'));
    const dirAtt = path.join(home, 'NexusFiles', 'cloud-Mai');
    try {
      f.attivita = fs.readdirSync(dirAtt).slice(0, 12).map((n) => `${n}: ${leggiPiccolo(path.join(dirAtt, n)).replace(/\s+/g, ' ').slice(0, 400)}`);
    } catch (e) { f.attivita = `<${e.code || 'illeggibile'}>`; }
    fotografie.push(f);
  };

  const up1 = await fleet.up('Mai');
  assert.equal(up1.ok, true, `primo up: ${JSON.stringify(up1)}`);
  await fotografa('subito dopo l\'up');
  const primaRiga = fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean)[0];
  assert.equal(primaRiga, 'assente', 'host-v1 ancora assente subito prima dello spawn');
  const st = fs.lstatSync(hostRoot);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isDirectory(), true, 'il layout lo crea il binario');
  const ctx1 = JSON.parse(fs.readFileSync(path.join(vlCellBaseDir(home, OWNER_INSTANCE_ID, 'Mai'), 'host-context.json'), 'utf8'));
  assert.equal(ctx1.serverRoot, hostRoot, 'serverRoot resta la root reale');
  assert.equal(String(ctx1.serverRoot).includes('nc-vl-cap-'), false);
  assert.equal(ctx1.hostIdentity && ctx1.hostIdentity.state, 'live');
  assert.equal(tickets.length, 1, 'un solo ticket al primo up');
  // Strato 2c: `up` risponde subito dal record canonico; la consegna completa
  // si osserva dopo, con attesa BOUNDED del terminale `submitted` della STESSA
  // tupla (launchId del payload, generazione 0) e prova che il bootstrap e'
  // arrivato UNA sola volta al modello controllato — tutto PRIMA del down.
  assert.ok(up1.prompt && ['pending', 'submitted', 'unknown'].includes(up1.prompt.state), `prompt: ${JSON.stringify(up1.prompt)}`);
  const lancio1 = tickets[0].promptOutcome.launchId;
  assert.equal(up1.prompt.launchId, lancio1, 'la tupla di up e\' del lancio del payload');
  const attesaFino = Date.now() + 60000;
  let tupla = null;
  let ultimaTupla = null;
  let ultimaFoto = Date.now();
  while (Date.now() < attesaFino) {
    if (Date.now() - ultimaFoto >= 2000) { ultimaFoto = Date.now(); await fotografa(`+${60000 - (attesaFino - Date.now())} ms`); }
    const st = await fleet.status();
    const cella = (st.cells || []).find((c) => c.cell === 'Mai');
    if (cella) ultimaTupla = cella.promptDelivery === undefined ? null : cella.promptDelivery;
    if (cella && cella.promptDelivery && cella.promptDelivery.state === 'submitted') { tupla = cella.promptDelivery; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!tupla) {
    // Diagnostica del timeout: l'ultima tupla osservata e il testo del pane
    // (solo testo, nessun segreto) dicono se il client TUI non accetta il
    // prompt (onboarding, dialogo) o se lo stato non si propaga.
    const cattura = spawnSync(TMUX, ['capture-pane', '-p', '-t', '=cloud-Mai'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: tmuxd, TMUX: '' },
    });
    await fotografa('al timeout');
    for (const f of fotografie) process.stderr.write(`[diagnostica first-up] ${JSON.stringify(f)}\n`);
    process.stderr.write(`[diagnostica first-up] ultimo promptDelivery: ${JSON.stringify(ultimaTupla)}\n`);
    process.stderr.write(`[diagnostica first-up] pane cloud-Mai (exit ${cattura.status}):\n${String(cattura.stdout || cattura.stderr || '').slice(0, 4000)}\n`);
  }
  assert.ok(tupla, `terminale submitted non osservato entro il limite; ultimo promptDelivery: ${JSON.stringify(ultimaTupla)}`);
  assert.equal(tupla.launchId, lancio1);
  assert.equal(tupla.generation, 0);
  const chat = () => richieste.filter((u) => String(u).includes('/chat/completions')).length;
  const finoChat = Date.now() + 30000;
  while (Date.now() < finoChat && chat() < 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(chat(), 1, 'il bootstrap arriva al modello controllato una sola volta');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(chat(), 1, 'nessun reinvio dopo il terminale');

  const down1 = await fleet.down('Mai');
  assert.equal(down1.ok, true, `down: ${JSON.stringify(down1)}`);

  const up2 = await fleet.up('Mai');
  assert.equal(up2.ok, true, `secondo up: ${JSON.stringify(up2)}`);
  assert.equal(tickets.length, 2, 'un prompt anche al secondo up, nessuno in piu\'');
  assert.equal(sha256(marker), markerHash, 'la cella di controllo e\' intatta');
  assert.equal(fs.existsSync(path.join(baseB, 'state', 'vl', 'host-v1')), false);
  const rimaste = fs.readdirSync('/tmp').filter((n) => n.startsWith('nc-vl-cap-') && !capPrima.has(n));
  assert.deepEqual(rimaste, [], `sonda temporanea rimasta: ${rimaste.join(',')}`);
  assert.equal(vivo(LIVE), livePrima, 'il tmux della flotta non e\' stato toccato');
});
