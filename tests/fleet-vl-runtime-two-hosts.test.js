'use strict';
// Runtime proof with two REAL hosts: two cells, the same engine, the SAME
// operator HOME, the per-cell XDG coming from the real NexusCrew composition.
//
// What the unit matrices cannot show: that the isolation holds down to the
// host, that a restart resumes the transcript, and that a new session of one
// cell leaves the other cell untouched. The binary is the declared one
// (NEXUSCREW_VL_REAL_BIN), the provider is a mock on the loopback, the host
// and the TUI are the real ones (a real terminal is required, so the TUI runs
// inside a tmux pane owned by this test).
//
// The test is skipped when the binary is not declared: a path on this machine
// is not a fact of the product.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { ensureVlCellDirs, writeVlCellCatalog } = require('../lib/fleet/managed.js');

const REAL_BIN = (process.env.NEXUSCREW_VL_REAL_BIN || '').trim();
const TMUX = (process.env.NEXUSCREW_TMUX_BIN || '/usr/bin/tmux').trim();
const SKIP = 'NEXUSCREW_VL_REAL_BIN non dichiarata o binario assente: prova runtime saltata';

function sh(cmd, args, env) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return `ERR: ${e.stderr || e.message}`;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function until(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Every file under a tree, with its content hash: the comparison that says
// "this cell was not touched". A socket is not a file: it is described by
// its type and its mtime, so a host that had been restarted would still
// show up as a change.
function treeHashes(dir) {
  const out = new Map();
  const walk = (current) => {
    let names = [];
    try { names = fs.readdirSync(current); } catch (_) { return; }
    for (const name of names.sort()) {
      const p = path.join(current, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const key = path.relative(dir, p);
      out.set(key, st.isFile() ? `${st.size}:${sha256(p)}` : `${st.mode}:${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

function sameTree(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

test('due celle, stesso engine e stessa HOME: due host reali distinti, preferenze distinte, transcript che riprende, nuova sessione che non tocca B', async (t) => {
  if (!REAL_BIN || !fs.existsSync(REAL_BIN)) { t.skip(SKIP); return; }
  if (!fs.existsSync(TMUX)) { t.skip('tmux non disponibile: la TUI reale richiede un terminale vero'); return; }

  // The per-cell tree ends in a unix socket: the whole path must fit in
  // SUN_PATH_MAX, so the scratch root is short on purpose.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvl-'));
  const home = root;
  const owner = 'a'.repeat(32);
  const started = [];
  const sessions = [];

  // The mock provider: it records every request (with the model it carries)
  // and answers with a distinguishable text. Nothing leaves the loopback.
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let model = null;
      try { model = JSON.parse(body).model; } catch (_) { /* not a json body */ }
      requests.push({ method: req.method, url: req.url, model, body });
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: {"choices":[{"delta":{"role":"assistant","content":"risposta-${model}"},"index":0}]}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const source = path.join(home, '.config', 'vl', 'config.toml');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    'default_profile = "mock-a"',
    '',
    '[profiles.mock-a]',
    'provider = "openai-compat"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'model = "mock-a"',
    '',
    '[profiles.mock-b]',
    'provider = "openai-compat"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'model = "mock-b"',
    '',
  ].join('\n'));

  // The real NexusCrew composition: per-cell identity directory, per-cell XDG
  // trio, per-cell catalog copy. Same HOME for both cells, as a shared
  // operator would be.
  const A = ensureVlCellDirs(home, owner, 'CellaA');
  const B = ensureVlCellDirs(home, owner, 'CellaB');
  const catalog = fs.readFileSync(source, 'utf8');
  writeVlCellCatalog(A.configVlDir, source, catalog);
  writeVlCellCatalog(B.configVlDir, source, catalog);
  assert.notEqual(A.env.XDG_STATE_HOME, B.env.XDG_STATE_HOME, 'stato distinto');
  assert.notEqual(A.env.XDG_CONFIG_HOME, B.env.XDG_CONFIG_HOME, 'config distinte');

  const envLine = (dirs) => [
    `HOME=${home}`, 'TERM=xterm-256color',
    `XDG_STATE_HOME=${dirs.env.XDG_STATE_HOME}`,
    `XDG_DATA_HOME=${dirs.env.XDG_DATA_HOME}`,
    `XDG_CONFIG_HOME=${dirs.env.XDG_CONFIG_HOME}`,
  ].join(' ');

  const rootOf = (dirs) => path.join(dirs.env.XDG_STATE_HOME, 'vl', 'host-v1');
  const startTui = (label, dirs, extraArgs) => {
    const name = `nc-vl-${label}-${process.pid}-${started.length}`;
    sessions.push(name);
    const args = extraArgs || [];
    sh(TMUX, ['new-session', '-d', '-s', name, '-x', '160', '-y', '50',
      `sh -c '${envLine(dirs)} ${REAL_BIN} ${args.join(' ')}; sleep 120'`]);
    started.push(name);
    return name;
  };
  const pane = (name) => sh(TMUX, ['capture-pane', '-p', '-t', name]);
  const send = (name, text) => sh(TMUX, ['send-keys', '-t', name, text, 'Enter']);

  t.after(() => {
    for (const name of sessions) { try { sh(TMUX, ['kill-session', '-t', name]); } catch (_) { /* gone */ } }
    for (const dirs of [A, B]) {
      try { sh(REAL_BIN, ['shutdown', '--server-root', rootOf(dirs)], { ...process.env, HOME: home }); } catch (_) { /* already stopped */ }
    }
    try { server.close(); } catch (_) { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* removed */ }
  });

  // --- two real hosts, distinct down to the socket --------------------------
  const tuiA = startTui('a', A);
  const tuiB = startTui('b', B);

  const live = async (dirs) => {
    const out = sh(REAL_BIN, ['host', 'status', '--server-root', rootOf(dirs)], { ...process.env, HOME: home });
    const m = /vl host: LIVE[\s\S]*?pid: (\d+)/.exec(out);
    return m ? { out, pid: Number(m[1]) } : null;
  };
  const hostA = await until(() => live(A), 30000);
  const hostB = await until(() => live(B), 30000);
  const panes = `\n--- pane A ---\n${pane(tuiA)}\n--- pane B ---\n${pane(tuiB)}`;
  assert.ok(hostA, `host A non live:\n${sh(REAL_BIN, ['host', 'status', '--server-root', rootOf(A)], { ...process.env, HOME: home })}${panes}`);
  assert.ok(hostB, `host B non live:\n${sh(REAL_BIN, ['host', 'status', '--server-root', rootOf(B)], { ...process.env, HOME: home })}${panes}`);
  assert.notEqual(hostA.pid, hostB.pid, 'due host distinti, due processi distinti');
  assert.notEqual(rootOf(A), rootOf(B), 'due server-root distinti');
  const sockA = path.join(rootOf(A), 'server', '.vl', 'control.sock');
  const sockB = path.join(rootOf(B), 'server', '.vl', 'control.sock');
  assert.ok(fs.existsSync(sockA) && fs.existsSync(sockB), 'socket di controllo presenti in entrambe le celle');
  assert.notEqual(sockA, sockB, 'socket distinti');

  // --- distinct preferences, one per cell -----------------------------------
  const envSel = (dirs) => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: dirs.env.XDG_CONFIG_HOME });
  sh(REAL_BIN, ['select', 'mock-a'], envSel(A));
  sh(REAL_BIN, ['select', 'mock-b'], envSel(B));
  const selA = path.join(A.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
  const selB = path.join(B.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
  assert.ok(fs.existsSync(selA) && fs.existsSync(selB), 'la preferenza sta nella config privata della cella');
  assert.match(fs.readFileSync(selA, 'utf8'), /mock-a/, 'A preferisce il proprio profilo');
  assert.match(fs.readFileSync(selB, 'utf8'), /mock-b/, 'B preferisce il proprio profilo');
  assert.notEqual(fs.readFileSync(selA, 'utf8'), fs.readFileSync(selB, 'utf8'), 'preferenze distinte');

  // --- a real turn on A, against the mock ----------------------------------
  send(tuiA, 'turno-di-A');
  const turnA = await until(() => requests.find((r) => r.body && r.body.includes('turno-di-A')), 30000);
  assert.ok(turnA, 'A ha parlato con il provider mock');
  assert.equal(turnA.model, 'mock-a', 'A ha usato il modello della propria preferenza');
  assert.equal(requests.length, 1, 'B non ha prodotto richieste: le celle non condividono il provider');
  const journalA = path.join(rootOf(A), 'sessions', 'default', '.vl', 'journal');
  const journalB = path.join(rootOf(B), 'sessions', 'default', '.vl', 'journal');
  assert.ok(fs.existsSync(journalA), 'il transcript di A esiste');
  const sizeAfterTurn = fs.statSync(journalA).size;
  assert.ok(sizeAfterTurn > 0, 'il transcript di A non e\' vuoto');

  // --- restart: the transcript is resumed -----------------------------------
  sh(TMUX, ['kill-session', '-t', tuiA]);
  sessions.splice(sessions.indexOf(tuiA), 1);
  const tuiA2 = startTui('a2', A);
  const afterRestart = await until(() => {
    const p = pane(tuiA2);
    return p && p.includes('vivling') ? p : null;
  }, 30000);
  assert.ok(afterRestart, 'la TUI riaggancia l\'host vivo');
  send(tuiA2, 'turno-dopo-il-restart');
  const turn2 = await until(() => requests.find((r) => r.body && r.body.includes('turno-dopo-il-restart')), 30000);
  assert.ok(turn2, 'il turno dopo il restart e\' arrivato al provider');
  assert.ok(turn2.body.includes('turno-di-A'), 'il transcript ripreso contiene il turno precedente');
  assert.ok(fs.statSync(journalA).size > sizeAfterTurn, 'il transcript e\' cresciuto');
  assert.equal(requests.length, 2, 'nessun provider estraneo');

  // --- a new session of A does not touch B ----------------------------------
  const treeBBefore = treeHashes(rootOf(B));
  // The rotation is the supervisor's move: the previous TUI goes away, the
  // host is stopped cleanly, and only then the new one starts with --new. A
  // live host (or a TUI still attached) makes the rotation refuse itself.
  sh(TMUX, ['kill-session', '-t', tuiA2]);
  sessions.splice(sessions.indexOf(tuiA2), 1);
  sh(REAL_BIN, ['shutdown', '--server-root', rootOf(A)], { ...process.env, HOME: home });
  await until(() => !live(A), 20000);
  const tuiANew = startTui('anew', A, ['--new']);
  const rotated = await until(() => {
    const dir = path.join(rootOf(A), 'sessions');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return names.some((n) => n.startsWith('archive-')) ? names : null;
  }, 30000);
  assert.ok(rotated, `la sessione di A non e\' stata archiviata: ${JSON.stringify(fs.readdirSync(path.join(rootOf(A), 'sessions')))}\n--- pane new ---\n${pane(tuiANew)}\n--- tree A ---\n${sh('find', [rootOf(A), '-maxdepth', '4'])}\n--- tree data A ---\n${sh('find', [A.env.XDG_DATA_HOME, '-maxdepth', '4'])}`);
  assert.ok(sameTree(treeBBefore, treeHashes(rootOf(B))), 'B e\' rimasto intatto: nessun file cambiato');
  const readyNew = await until(() => {
    const p = pane(tuiANew);
    return p && p.includes('vivling') ? p : null;
  }, 30000);
  assert.ok(readyNew, `la TUI dopo il --new non e\' pronta:\n${pane(tuiANew)}`);
  send(tuiANew, 'turno-dopo-il-new');
  const turnNew = await until(() => requests.find((r) => r.body && r.body.includes('turno-dopo-il-new')), 30000);
  assert.ok(turnNew, 'il turno dopo il --new e\' arrivato al provider');
  assert.ok(!turnNew.body.includes('turno-di-A'), 'il transcript e\' ripartito vuoto');
  assert.ok(sameTree(treeBBefore, treeHashes(rootOf(B))), 'B e\' rimasto intatto anche dopo il turno');

  // --- the journal of B never grew ------------------------------------------
  assert.ok(fs.existsSync(journalB), 'B ha il suo transcript');
  assert.equal(requests.length, 3, 'tre richieste, tutte riconducibili ad A');
});
