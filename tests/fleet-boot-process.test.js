'use strict';
// Processo VERO del boot companion:
// il VERO entrypoint CLI `fleet-boot` gira in un processo separato contro un
// daemon di prova della stessa installazione (createServer reale, lease
// manager attivo, tmux VERO su TMUX_TMPDIR privato). Prova che:
//   1. i lanci nascono dal percorso API del daemon (record v2 + lease + control):
//      dopo l'USCITA del processo CLI la lease si rinnova ancora (il
//      supervisore parla col daemon, non col companion) e il down via API
//      funziona sul record nato dal POST;
//   2. due companion concorrenti non producono MAI un secondo lancio della
//      stessa cella.
// Mai la flotta viva: tmux su socket di test, HOME/isolated-home di test,
// server chiuso per socket esatto con uscita verificata, inventario processi
// vuoto a fine corsa.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('../lib/server.js');
const { verificaUscitaServer } = require('./tmux-server-exit-guard.js');

const TMUX = '/bin/tmux';
const REPO = path.resolve(__dirname, '..');

function sh(cmd, args, env, timeoutMs = 10000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env });
}

function attendi(check, ms, passo, etichetta) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error(`attesa scaduta: ${etichetta}`)); return; }
      setTimeout(tick, passo);
    };
    tick();
  });
}

function leggiGrace(home, cella) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'run', 'cell-leases', `${cella}.json`), 'utf8'));
    return typeof j.graceDeadline === 'number' ? j.graceDeadline : null;
  } catch (_) { return null; }
}

// Il daemon di prova: createServer reale con lease manager attivo e tmux vero.
// Ritorna tutto ciò che serve al test e registra la chiusura completa.
async function preparaDaemon(t, celleBoot) {
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  const prevLcCtype = process.env.LC_CTYPE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bootp-'));
  fs.mkdirSync(path.join(home, 'cwd'), { recursive: true });
  fs.mkdirSync(path.join(home, 'files'), { recursive: true });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { recursive: true, mode: 0o700 });

  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bootp-m-'));
  const nodeId = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(home, '.nexuscrew', 'nodes.json'),
    JSON.stringify({ schemaVersion: 3, nodeId, nodes: [] }), { mode: 0o600 });

  const defsPath = path.join(home, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'e', label: 'cat', command: '/bin/cat', args: [], promptMode: 'send-keys' }],
    cells: celleBoot.map((id) => ({ id, cwd: path.join(home, 'cwd'), engine: 'e', boot: true })),
  }), { mode: 0o600 });

  const { server, token } = createServer({
    home,
    tokenPath: path.join(home, '.nexuscrew', 'token'),
    filesRoot: path.join(home, 'files'),
    fleetDefsPath: defsPath,
    tmuxBin: TMUX,
    cellLeaseEnabled: true,
  });
  // Il daemon vive nel processo di test: il socket condiviso che le sue celle
  // useranno si risolve da QUI (come fleet-shared-server-launch.test.js),
  // quindi il TMUX_TMPDIR privato va impostato nel processo stesso — le sh()
  // del test e il companion lo portano comunque esplicito nel loro env.
  process.env.TMUX_TMPDIR = tmuxd;
  process.env.LC_CTYPE = 'C.UTF-8';
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  // Il companion scopre la porta da config.json: nessuna porta hardcoded.
  fs.writeFileSync(path.join(home, '.nexuscrew', 'config.json'), JSON.stringify({ port }), { mode: 0o600 });

  const sharedSocketDir = path.join(tmuxd, `tmux-${process.getuid()}`);
  const tmuxEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home, TMUX_TMPDIR: tmuxd, TMUX: '', TMUX_PANE: '', LC_CTYPE: 'C.UTF-8' });
  const hasSession = (nome) => sh(TMUX, ['has-session', '-t', `=${nome}`], tmuxEnv()).status === 0;
  const api = async (methodo, urlPath, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: methodo,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  t.after(async () => {
    try { await api('POST', '/api/fleet/down', { cell: celleBoot[0] }); } catch (_) {}
    try { server.close(); } catch (_) {}
    // Server DI TEST chiuso per socket esatto, uscita verificata, poi nessun
    // client può più parlarci (point 3 of the design clarification).
    let serverPid = null;
    try {
      const pidOut = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}
    try { sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'kill-server'], tmuxEnv()); } catch (_) {}
    if (serverPid) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(serverPid, 0); } catch (e) { if (e && e.code === 'ESRCH') break; }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
      verificaUscitaServer(spawnSync, serverPid);
    }
    // Inventario processi vuoto: nessun processo sopravvive legato alla sandbox.
    const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    const superstite = String(ps.stdout || '').split('\n').filter((l) => l.includes(home) && !l.includes('ps -eo'));
    if (superstite.length) throw new Error(`processi orfani sulla sandbox: ${superstite.slice(0, 3).join(' | ')}`);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(tmuxd, { recursive: true, force: true }); } catch (_) {}
    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    if (prevLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevLcCtype;
  });

  return { home, port, token, nodeId, tmuxEnv, hasSession, api, tmuxd };
}

// Il VERO entrypoint come processo separato, con l'installazione della sandbox.
function spawnCompanion(ctx) {
  return spawn(process.execPath, [path.join(REPO, 'bin', 'nexuscrew.js'), 'fleet-boot'], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: ctx.home,
      TMUX_TMPDIR: ctx.tmuxd,
      TMUX: '', TMUX_PANE: '',
      LC_CTYPE: 'C.UTF-8',
      NEXUSCREW_AUTO_UPDATE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function attendiExit(p, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('companion: uscita non avvenuta entro il budget')), timeoutMs);
    p.once('close', (code) => { clearTimeout(timer); resolve(code); });
    p.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Il fermo di gruppo può classificare 'stop-unknown' uno stop di fatto
// riuscito: se il server tmux non ha ancora raccolto il pane appena uscito,
// lo zombie tiene il PGID, la sonda non arriva a ESRCH e il censimento non
// promuove a 'noti' entro la propria finestra. In quel caso il down rifiuta
// con l'esito strutturato {code:'STOP_UNKNOWN', outcome:'stop-unknown',
// uscito:true} — l'uscita del supervisore è PROVATA, il fermo è avvenuto.
// La chiusura DUREVOLE del record dopo un censimento mancato passa dalle
// riconciliazioni esplicite (strati successivi del ciclo di vita), non da
// questo down: qui si accetta l'esito provato e si verificano i fatti che
// questo strato deve dimostrare. La corsa va comunque riportata al layer di
// fermo: non è un esito pulito.
function fermoSpurio(j) {
  return j && j.code === 'STOP_UNKNOWN' && j.outcome === 'stop-unknown' && j.uscito === true;
}

test('processo vero: il boot e\' client del daemon, la lease sopravvive all\'uscita del CLI, il down funziona', async (t) => {
  if (sh(TMUX, ['-V']).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  const ctx = await preparaDaemon(t, ['A', 'B']);

  const p = spawnCompanion(ctx);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const code = await attendiExit(p);
  assert.equal(code, 0, `companion uscito con ${code}: ${out}`);

  // (1) le celle sono nate dal PERCORSO API del daemon: sessioni vive sul
  // server di test e lease live anche a companion già uscito.
  assert.equal(ctx.hasSession('cloud-A'), true, 'sessione cloud-A avviata');
  assert.equal(ctx.hasSession('cloud-B'), true, 'sessione cloud-B avviata');
  const st = await ctx.api('GET', '/api/fleet/status');
  const leaseDi = (cella) => (st.json.cells || []).find((c) => c.cell === cella)?.lease;
  assert.equal(leaseDi('A'), 'live', 'lease live per A dopo l\'uscita del CLI');
  assert.equal(leaseDi('B'), 'live', 'lease live per B dopo l\'uscita del CLI');

  // (2) la lease si RINNOVA senza il companion: il supervisore di quel lancio
  // parla col daemon. Attendo che la graceDeadline avanzi (refresh 20 s).
  const g1 = leggiGrace(ctx.home, 'A');
  assert.ok(typeof g1 === 'number', 'file di lease presente per A');
  await attendi(() => {
    const g2 = leggiGrace(ctx.home, 'A');
    return typeof g2 === 'number' && g2 > g1;
  }, 45000, 1000, 'rinnovo della lease di A dopo l\'uscita del companion');

  // (3) il down via API funziona sul record nato dal POST: la pratica si chiude.
  const down = await ctx.api('POST', '/api/fleet/down', { cell: 'A' });
  if (down.status === 200) {
    assert.equal(ctx.hasSession('cloud-A'), false, 'sessione cloud-A chiusa dal down');
    const st2 = await ctx.api('GET', '/api/fleet/status');
    assert.notEqual((st2.json.cells || []).find((c) => c.cell === 'A')?.lease, 'live', 'lease di A non più live dopo il down');
  } else {
    assert.ok(fermoSpurio(down.json), `down A: esito inatteso ${JSON.stringify(down.json)}`);
    assert.equal(ctx.hasSession('cloud-A'), false, 'sessione cloud-A comunque assente (uscita provata)');
    const stg = await ctx.api('GET', '/api/fleet/status');
    assert.notEqual((stg.json.cells || []).find((c) => c.cell === 'A')?.lease, 'live', 'lease di A non live (uscita provata)');
  }
});

test('processo vero: due companion concorrenti, mai un secondo lancio della stessa cella', async (t) => {
  if (sh(TMUX, ['-V']).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  const ctx = await preparaDaemon(t, ['X']);

  const p1 = spawnCompanion(ctx);
  const p2 = spawnCompanion(ctx);
  const [c1, c2] = await Promise.all([attendiExit(p1), attendiExit(p2)]);

  // La sessione esiste UNA volta sola: chi dei due ha perso la corsa ha
  // ricevuto il rifiuto strutturato del daemon e non ha rilanciato.
  assert.equal(ctx.hasSession('cloud-X'), true, 'la cella X è avviata');
  const lista = sh(TMUX, ['list-sessions', '-F', '#{session_name}'], ctx.tmuxEnv());
  const sessioni = String(lista.stdout || '').split('\n').filter((s) => s.startsWith('cloud-'));
  assert.deepEqual(sessioni, ['cloud-X'], `una sola sessione cloud, non ${sessioni.length}`);
  const st = await ctx.api('GET', '/api/fleet/status');
  assert.equal((st.json.cells || []).find((c) => c.cell === 'X')?.lease, 'live', 'lease live per X');
  assert.ok(c1 === 0 || c2 === 0, `almeno un companion è riuscito (exit ${c1}/${c2})`);
  const chiuso = await ctx.api('POST', '/api/fleet/down', { cell: 'X' });
  if (chiuso.status !== 200) {
    assert.ok(fermoSpurio(chiuso.json), `down X: esito inatteso ${JSON.stringify(chiuso.json)}`);
  }
  assert.equal(ctx.hasSession('cloud-X'), false, 'sessione cloud-X assente a fine corsa');
});

test('processo vero: secondo companion sulla flotta già viva -> skip qualificato col binding REALE', async (t) => {
  if (sh(TMUX, ['-V']).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  const ctx = await preparaDaemon(t, ['A', 'B']);

  const p1 = spawnCompanion(ctx);
  const c1 = await attendiExit(p1);
  assert.equal(c1, 0, 'primo companion avvia A e B');
  assert.equal(ctx.hasSession('cloud-A'), true, 'sessione cloud-A avviata');
  assert.equal(ctx.hasSession('cloud-B'), true, 'sessione cloud-B avviata');

  // Il secondo companion riceve il 409 per entrambe le celle: la prova che
  // serve per lo skip arriva dal daemon VERO (record v2 attested + canale
  // posseduto + lease live + control armato/connesso e legato allo stesso
  // launchId), non da alcun fake. Exit 0 = skip qualificato, non fallimento.
  const p2 = spawnCompanion(ctx);
  const c2 = await attendiExit(p2);
  assert.equal(c2, 0, 'il secondo companion salta qualificato senza fallire');
  const lista = sh(TMUX, ['list-sessions', '-F', '#{session_name}'], ctx.tmuxEnv());
  const sessioni = String(lista.stdout || '').split('\n').filter((s) => s.startsWith('cloud-'));
  assert.deepEqual(sessioni.sort(), ['cloud-A', 'cloud-B'], 'nessun nuovo lancio delle celle già vive');
  const st = await ctx.api('GET', '/api/fleet/status');
  const leaseDi = (cella) => (st.json.cells || []).find((c) => c.cell === cella)?.lease;
  assert.equal(leaseDi('A'), 'live', 'lease di A ancora live: nessun rilancio');
  assert.equal(leaseDi('B'), 'live', 'lease di B ancora live: nessun rilancio');
});
