'use strict';
// T4 — cause-preserving Fleet up() diagnostics.
//
// The up() path of the built-in fleet crosses five boundaries:
//   1. preflight gates          (command trust, cwd, managed-engine config)
//   2. the secure launch broker (private runtime dir, payload, lifecycle)
//   3. tmux new-session         (session creation / duplicate)
//   4. pane/client early-exit   (readiness / liveness gate)
//   5. the cell client spawn    (ENOENT/EACCES/... surfaced via cell-exec)
//
// Each attaches a bounded {phase, code} cause (lib/fleet/causes.js) to its
// structured HTTP error; the router surfaces {status, code, phase} and NEVER
// free messages, cwd/path, argv, env, prompt, token or credentials.  These
// tests prove: the enum is stable for every reachable boundary; the UNKNOWN
// fallback is bounded; redaction holds; the success path is invariant.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { UNKNOWN, PHASES, CODES, codeOf, phaseOf } = require('../lib/fleet/causes.js');
const { httpError } = require('../lib/fleet/launch.js');
const { createDiagnostics } = require('../lib/diagnostics/store.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

// ===========================================================================
// 1. enum stability + bounded UNKNOWN fallback (pure unit)
// ===========================================================================

test('causes: PHASES/CODES are stable, well-formed, closed enums; UNKNOWN is the closed fallback', () => {
  assert.ok(PHASES.length >= 5, 'at least the five documented phases');
  assert.ok(CODES.includes(UNKNOWN), 'UNKNOWN is part of the closed code enum');
  for (const ph of PHASES) assert.match(ph, /^[a-z][a-z0-9-]*$/, `phase well-formed: ${ph}`);
  for (const c of CODES) assert.match(c, /^[A-Z][A-Z0-9_]*$/, `code well-formed: ${c}`);
  // known values pass through verbatim
  assert.equal(codeOf('CLIENT_EARLY_EXIT'), 'CLIENT_EARLY_EXIT');
  assert.equal(codeOf('SHELL_COMMAND_FAILED'), 'SHELL_COMMAND_FAILED');
  assert.equal(codeOf('LAUNCH_BROKER_UNSAFE'), 'LAUNCH_BROKER_UNSAFE');
  assert.equal(phaseOf('readiness'), 'readiness');
  assert.equal(phaseOf('spawn-client'), 'spawn-client');
  // everything else degrades to the bounded UNKNOWN fallback
  for (const bad of ['BOGUS', '', 'client early exit', 'DROP TABLE', ' ', undefined, null, 42, {}]) {
    assert.equal(codeOf(bad), UNKNOWN, `codeOf(${JSON.stringify(bad)}) -> UNKNOWN`);
    assert.equal(phaseOf(bad), UNKNOWN, `phaseOf(${JSON.stringify(bad)}) -> UNKNOWN`);
  }
});

test('httpError: optional bounded cause is attached; untagged and bogus input degrade to UNKNOWN', () => {
  // backward compatible: no cause, no data
  const plain = httpError(500, 'boom');
  assert.equal(plain.status, 500);
  assert.equal(plain.message, 'boom');
  assert.equal(plain.fleetCode, undefined);
  assert.equal(plain.fleetPhase, undefined);
  assert.equal(plain.data, undefined);

  // tagged cause + structured data coexist on distinct channels
  const tagged = httpError(409, 'sessione già in esecuzione', { detail: 'x' },
    { phase: 'new-session', code: 'SESSION_DUPLICATE' });
  assert.equal(tagged.status, 409);
  assert.deepEqual(tagged.data, { detail: 'x' });
  assert.equal(tagged.fleetCode, 'SESSION_DUPLICATE');
  assert.equal(tagged.fleetPhase, 'new-session');

  // bogus cause can never carry an unbounded/raw string
  const bogus = httpError(500, 'x', null, { phase: 'EVIL_PHASE', code: 'DROP TABLE' });
  assert.equal(bogus.fleetCode, UNKNOWN);
  assert.equal(bogus.fleetPhase, UNKNOWN);

  // partial cause: missing member degrades only that member
  const partial = httpError(500, 'x', null, { code: 'CLIENT_EARLY_EXIT' });
  assert.equal(partial.fleetCode, 'CLIENT_EARLY_EXIT');
  assert.equal(partial.fleetPhase, UNKNOWN);
});

// ===========================================================================
// 2. route-level: FLEET_ACTION_FAILED emits bounded cause; UNKNOWN fallback;
//    redaction; CELL_SPAWN_FAILED stays sanitized; success path invariant.
//    (mock fleet — isolates the router from tmux/runtime)
// ===========================================================================

async function bootRoutes(t, fleet) {
  const diagnostics = createDiagnostics();
  const app = express();
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), { diagnostics }));
  const server = await listen(app);
  t.after(() => close(server));
  return { diagnostics, port: server.address().port };
}
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/fleet/up`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('route: tagged up() failure -> FLEET_ACTION_FAILED {status,code,phase} bounded + structured HTTP body; diagnostics carry no secret', async (t) => {
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => {
      // Sensitive payload (as if unredacted) that must NEVER surface in the
      // bounded diagnostics meta: the cause triple replaces free-text cause.
      const e = new Error('client /home/alice/codex: Bearer SECRET OPENAI_API_KEY=leak');
      e.status = 500;
      e.fleetCode = 'CLIENT_EARLY_EXIT';
      e.fleetPhase = 'readiness';
      throw e;
    },
  };
  const { diagnostics, port } = await bootRoutes(t, fleet);
  const res = await post(port, { cell: 'Dev' });
  assert.equal(res.status, 500);
  const body = await res.json();
  // structured, bounded cause on the HTTP body
  assert.equal(body.code, 'CLIENT_EARLY_EXIT');
  assert.equal(body.phase, 'readiness');

  const recs = diagnostics.logs().records;
  assert.equal(recs.length, 1);
  const ev = recs[0];
  assert.equal(ev.code, 'FLEET_ACTION_FAILED');
  assert.deepEqual(ev.meta,
    { action: 'up', cell: 'Dev', state: 'failed', status: 500, code: 'CLIENT_EARLY_EXIT', phase: 'readiness' });
  // the bounded diagnostics payload never carries the free-text cause / secrets
  const text = JSON.stringify(recs);
  for (const forbidden of ['SECRET', '/home/alice', 'OPENAI_API_KEY=leak', 'Bearer']) {
    assert.equal(text.includes(forbidden), false, `diagnostics leak: ${forbidden}`);
  }
});

test('route: Shell command failure keeps the dedicated bounded cause', async (t) => {
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => {
      const e = new Error('command and diagnostic must not enter the event');
      e.status = 500;
      e.fleetCode = 'SHELL_COMMAND_FAILED';
      e.fleetPhase = 'readiness';
      throw e;
    },
  };
  const { diagnostics, port } = await bootRoutes(t, fleet);
  const res = await post(port, { cell: 'agy.native' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, 'SHELL_COMMAND_FAILED');
  assert.equal(body.phase, 'readiness');
  assert.deepEqual(diagnostics.logs().records[0].meta, {
    action: 'up', cell: 'agy.native', state: 'failed', status: 500,
    code: 'SHELL_COMMAND_FAILED', phase: 'readiness',
  });
  assert.equal(JSON.stringify(diagnostics.logs().records).includes('diagnostic must not enter'), false);
});

test('route: untagged/legacy up() failure -> bounded UNKNOWN code/phase; HTTP body keeps historical shape', async (t) => {
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => { const e = new Error('something legacy'); e.status = 502; throw e; },
  };
  const { diagnostics, port } = await bootRoutes(t, fleet);
  const res = await post(port, { cell: 'Dev' });
  assert.equal(res.status, 502);
  const body = await res.json();
  // untagged error: no structured code/phase on the body (backward compatible)
  assert.equal(body.code, undefined);
  assert.equal(body.phase, undefined);
  // ...but the diagnostics event is still bounded to UNKNOWN, never unbounded
  const ev = diagnostics.logs().records[0];
  assert.equal(ev.code, 'FLEET_ACTION_FAILED');
  assert.equal(ev.meta.code, UNKNOWN);
  assert.equal(ev.meta.phase, UNKNOWN);
  assert.equal(ev.meta.status, 502);
});

test('route: raw (uncoerced) fleetCode on the error is bounded by the router before it lands in diagnostics', async (t) => {
  // defense-in-depth: even if an upstream error carried a non-enum fleetCode,
  // the router coerces it so diagnostics can never persist an unbounded string.
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => {
      const e = new Error('x'); e.status = 500;
      e.fleetCode = 'DROP TABLE users'; e.fleetPhase = '../evil';
      throw e;
    },
  };
  const { diagnostics, port } = await bootRoutes(t, fleet);
  const res = await post(port, { cell: 'Dev' });
  const body = await res.json();
  assert.equal(body.code, UNKNOWN);
  assert.equal(body.phase, UNKNOWN);
  const ev = diagnostics.logs().records[0];
  assert.equal(ev.meta.code, UNKNOWN);
  assert.equal(ev.meta.phase, UNKNOWN);
  assert.equal(JSON.stringify(recsAll(diagnostics)).includes('DROP TABLE'), false);
  assert.equal(res.status, 500);
});

test('route: spawn-client failure still emits sanitized CELL_SPAWN_FAILED (unchanged contract)', async (t) => {
  // The spawn-client boundary is preserved by the dedicated CELL_SPAWN_FAILED
  // event (errno + client basename, already sanitized upstream by cell-exec).
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => {
      const e = new Error('client /home/alice/codex.js: nexuscrew cell spawn failed: EACCES codex.js Bearer SECRET');
      e.status = 500;
      // the runtime also tags the spawn boundary, but the router keeps using
      // the sanitized CELL_SPAWN_FAILED event for it (regex wins).
      e.fleetCode = 'SPAWN_CLIENT_FAILED'; e.fleetPhase = 'spawn-client';
      throw e;
    },
  };
  const { diagnostics, port } = await bootRoutes(t, fleet);
  const res = await post(port, { cell: 'Dev' });
  assert.equal(res.status, 500);
  const recs = diagnostics.logs().records;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].code, 'CELL_SPAWN_FAILED');
  assert.deepEqual(recs[0].meta,
    { action: 'up', cell: 'Dev', errno: 'EACCES', client: 'codex.js', status: 500 });
  const text = JSON.stringify(recs);
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('/home/alice'), false);
});

test('route: up() success -> 200, no structured cause, only STARTED/COMPLETED (no FAILED)', async (t) => {
  const diagnostics = createDiagnostics();
  diagnostics.setVerbose(true, 300); // retain info-level STARTED/COMPLETED
  const fleet = {
    available: true, capabilities: () => ['up'],
    up: async () => ({ ok: true, cell: 'Dev', session: 'work-build', prompt: null }),
  };
  const app = express();
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), { diagnostics }));
  const server = await listen(app);
  t.after(() => close(server));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/fleet/up`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cell: 'Dev' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, cell: 'Dev', session: 'work-build', prompt: null });
  assert.equal(body.code, undefined);
  assert.equal(body.phase, undefined);
  const codes = diagnostics.logs().records.map((r) => r.code);
  assert.deepEqual(codes, ['VERBOSE_ENABLED', 'FLEET_ACTION_STARTED', 'FLEET_ACTION_COMPLETED']);
  // success never emits a failure event
  assert.equal(codes.includes('FLEET_ACTION_FAILED'), false);
});

function recsAll(diagnostics) { return diagnostics.logs().records; }

// ===========================================================================
// 3. runtime boundaries: each reachable up() boundary attaches a stable cause.
//    (createBuiltinRuntime — the unit that owns the throw sites; mock tmux)
// ===========================================================================

// Node fake-tmux with behavior baked in (no env races between parallel tests).
function writeFakeTmux(dir, cfg) {
  const p = path.join(dir, 'fake-tmux.cjs');
  const body = `#!/usr/bin/env node
'use strict';
const cfg = ${JSON.stringify(cfg)};
const cmd = process.argv[2] || '';
const out = (s) => process.stdout.write(s);
const er = (s) => process.stderr.write(s);
switch (cmd) {
  case 'new-session':
    if (cfg.duplicate) { er('duplicate session: work-build'); process.exit(1); }
    if (cfg.newSessionError) { er(cfg.newSessionError); process.exit(2); }
    if (cfg.paneId) out(cfg.paneId + '\\n');
    process.exit(0);
  case 'has-session':
    process.exit(cfg.alive === false ? 1 : 0);
  case 'display-message':
    out((cfg.paneDead || 0) + '\\t' + (cfg.paneStatus == null ? '' : cfg.paneStatus) + '\\t' + (cfg.paneId || '%0') + '\\n');
    process.exit(0);
  case 'capture-pane':
    out(cfg.capture || '');
    process.exit(0);
  default:
    process.exit(0);
}
`;
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

function makeWorld(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nccauses-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const command = path.join(home, 'bin', 'client');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  const tmuxBin = writeFakeTmux(root, over.tmux || {});
  const defs = over.defs({
    command, cwd, env: over.env || null,
    promptMode: over.promptMode || 'flag',
  });
  atomicWrite(defsPath, defs);
  const boot = loadDefinitions(defsPath);
  const launchBroker = over.broker || { issue: async () => ({ socketPath: '/x', nonce: 'n'.repeat(64) }), close: async () => {} };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: over.launchReadyMs != null ? over.launchReadyMs : 40 },
    home, defsPath, tmuxBin, readonly: () => false, launchBroker, boot,
  });
  return { runtime, root, home, cwd, command, defsPath, tmuxBin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const baseDefs = ({ command, cwd, env, promptMode }) => ({
  schemaVersion: 1,
  engines: [{
    id: 'sh', label: 'Shell', rc: true, command, args: [],
    ...(env ? { env } : {}), promptMode,
    ...(promptMode === 'flag' ? { promptFlag: '--ps' } : {}),
  }],
  cells: [{ id: 'Dev', tmuxSession: 'work-build', cwd, engine: 'sh', boot: false }],
});

test('runtime up: preflight/command-untrusted -> COMMAND_UNTRUSTED / preflight (400, no tmux launched)', async () => {
  const w = makeWorld({ defs: ({ cwd }) => baseDefs({ command: 'claude', cwd, promptMode: 'flag' }) });
  try {
    await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 400
      && e.fleetCode === 'COMMAND_UNTRUSTED' && e.fleetPhase === 'preflight');
  } finally { w.cleanup(); }
});

test('runtime up: preflight/cwd-invalid -> CWD_INVALID / preflight (400)', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncout-'));
  try {
    const w = makeWorld({ defs: ({ command }) => baseDefs({ command, cwd: outside, promptMode: 'flag' }) });
    try {
      await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 400
        && e.fleetCode === 'CWD_INVALID' && e.fleetPhase === 'preflight');
    } finally { w.cleanup(); }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('runtime up: launch-broker maps each broker failure to a bounded code on phase launch-broker (500)', async () => {
  for (const [bmsg, expected] of [
    ['unsafe launch broker directory', 'LAUNCH_BROKER_UNSAFE'],
    ['launch payload too large', 'LAUNCH_BROKER_PAYLOAD'],
    ['launch broker closed', 'LAUNCH_BROKER_CLOSED'],
    ['/private/runtime.sock: EADDRINUSE Bearer leaked', 'LAUNCH_BROKER_FAILED'],
  ]) {
    const w = makeWorld({
      env: { MANAGED_KEY: 'value' },
      broker: { issue: async () => { throw new Error(bmsg); }, close: async () => {} },
      defs: baseDefs,
    });
    try {
      await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 500
        && e.fleetCode === expected && e.fleetPhase === 'launch-broker'
        && !/private|Bearer|leaked|EADDRINUSE/.test(e.message));
    } finally { w.cleanup(); }
  }
});

test('runtime up: new-session failed -> NEW_SESSION_FAILED / new-session (500)', async () => {
  const w = makeWorld({
    tmux: { newSessionError: 'tmux: unknown device' },
    defs: baseDefs,
  });
  try {
    await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 500
      && e.fleetCode === 'NEW_SESSION_FAILED' && e.fleetPhase === 'new-session');
  } finally { w.cleanup(); }
});

test('runtime up: new-session duplicate -> SESSION_DUPLICATE / new-session (409)', async () => {
  const w = makeWorld({ tmux: { duplicate: true }, defs: baseDefs });
  try {
    await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 409
      && e.fleetCode === 'SESSION_DUPLICATE' && e.fleetPhase === 'new-session');
  } finally { w.cleanup(); }
});

test('runtime up: readiness early-exit -> CLIENT_EARLY_EXIT / readiness (500, redacted)', async () => {
  const w = makeWorld({
    tmux: { paneId: '%9', paneDead: '1', paneStatus: 7 },
    defs: baseDefs,
  });
  try {
    writeFakeTmux(w.root, {
      paneId: '%9', paneDead: '1', paneStatus: 7,
      capture: `failed login ${w.home}/Dev\nBearer hush`,
    });
    await assert.rejects(() => w.runtime.up('Dev'), (e) => {
      assert.equal(e.status, 500);
      assert.equal(e.fleetCode, 'CLIENT_EARLY_EXIT');
      assert.equal(e.fleetPhase, 'readiness');
      // the redacted message (runtime duty) never carries the raw secret/path
      assert.equal(/hush/.test(e.message), false);
      assert.equal(e.message.includes(w.home), false);
      return true;
    });
  } finally { w.cleanup(); }
});

test('runtime up: spawn-client failure -> SPAWN_CLIENT_FAILED / spawn-client (500)', async () => {
  // cell-exec writes the stable 'cell spawn failed: <ERRNO> <basename>' marker
  // to stderr; the readiness capture carries it, so the runtime tags the
  // spawn-client boundary (the router then emits sanitized CELL_SPAWN_FAILED).
  const w = makeWorld({
    tmux: { paneId: '%9', paneDead: '1', paneStatus: 1, capture: 'nexuscrew cell spawn failed: ENOENT codex' },
    defs: baseDefs,
  });
  try {
    await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 500
      && e.fleetCode === 'SPAWN_CLIENT_FAILED' && e.fleetPhase === 'spawn-client');
  } finally { w.cleanup(); }
});

test('runtime up: success path is invariant — no cause attached, returns ok', async () => {
  const w = makeWorld({ tmux: { paneId: '%9', paneDead: '0' }, defs: baseDefs });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.cell, 'Dev');
    assert.equal(res.session, 'work-build');
  } finally { w.cleanup(); }
});

test('runtime up: untagged input error (unknown cell) leaves no cause -> router UNKNOWN fallback', async () => {
  // validate-style gates (cella sconosciuta / engine dangling) are NOT boundary
  // causes; they carry no fleetCode, so the router degrades them to bounded UNKNOWN.
  const w = makeWorld({ defs: baseDefs });
  try {
    await assert.rejects(() => w.runtime.up('Nope'), (e) => e.status === 400
      && e.fleetCode === undefined && e.fleetPhase === undefined);
  } finally { w.cleanup(); }
});
