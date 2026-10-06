'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { EventEmitter } = require('node:events');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { main } = require('../lib/fleet/cell-exec.js');
const { createMcpServer } = require('../lib/mcp/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const { notifyRoutes } = require('../lib/notify/routes.js');
function fixture(t, { version = '0.160.0', flag = true, platform = 'android', client = 'codex' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-embedded-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  const binary = path.join(home, '.local/bin', client);
  fs.writeFileSync(binary, `#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? ${JSON.stringify('codex-cli '+version)} : ${JSON.stringify(flag ? 'Usage: codex --no-daemon' : 'Usage: codex')});\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.nexuscrew]\ncommand="node"\nargs=["nexuscrew", "mcp"]\nenv_vars=["EXISTING"]\n');
  const cell = { id: 'Reviewer', tmuxSession: 'demo-Reviewer' };
  const engine = { id: `${client}.native`, managed: { client, provider: 'native', model: '', permissionPolicy: 'standard' } };
  const cfg = { home, platform, env: {}, nodeExecPath: process.execPath };
  return { home, binary, cell, cfg, resolve: () => resolveManagedEngine(engine, cell, cfg) };
}
test('a supported Termux Codex launch disables shared daemon reuse and passes dynamic MCP variable names', t => {
  const f = fixture(t); const out = f.resolve(); assert.equal(out.ok, true, out.reason);
  assert.ok(out.engine.args.includes('--no-daemon'));
  const override = out.engine.args.find(arg => arg.startsWith('mcp_servers.nexuscrew.env_vars='));
  assert.ok(override);
  const names = JSON.parse(override.slice(override.indexOf('=')+1));
  assert.ok(['EXISTING','MCP_DEVICE','NEXUSCREW_MCP_SESSION','TMUX','TMUX_PANE'].every(name => names.includes(name)));
  assert.equal(out.engine.command, process.execPath, 'the capability probe follows the same Node shim path as launch');
});
for (const unsupported of [{ flag: false }, { version: 'unknown' }]) test(`an unsupported Termux runtime refuses launch with a diagnostic (${JSON.stringify(unsupported)})`, t => {
  const f = fixture(t, unsupported); const out = f.resolve();
  assert.equal(out.ok, false);
  assert.match(out.reason, /daemon|embedded|identity/i);
});
test('native Codex outside Termux uses isolated launch', t => {
  const out = fixture(t, { platform: 'linux' }).resolve(); assert.equal(out.ok, true);
  assert.equal(out.engine.args.includes('--no-daemon'), true);
});
test('codex-vl keeps its existing authority contract on Termux', t => {
  const f = fixture(t, { client: 'codex-vl' });
  f.cfg.fleetIdentityMode = 'authority'; f.cfg.identityAuthority = { fixture: true };
  const out = f.resolve(); assert.equal(out.ok, true, out.reason);
  assert.equal(out.engine.args.includes('--no-daemon'), false);
});
async function callback(t, { mismatch = false, missing = false } = {}) {
  const f = fixture(t); const out = f.resolve(); assert.equal(out.ok, true, out.reason);
  const frames = []; const pastes = [];
  const asks = createAsksStore({ dir: f.home });
  const app = express();
  app.use('/api', notifyRoutes({ cfg: {}, notifier: { emitRaw() {}, emit: async frame => { frames.push(frame); return { ui: 1, push: 0 }; } },
    push: { sendToAll: async () => ({ sent: 0 }), vapidPublicKey: () => 'fixture' },
    asks, submit: async (...args) => { const result = await (async (session, text) => { pastes.push({ session, text }); return true; })(...args); return { outcome: result ? 'submitted' : 'failed-pre-paste' }; },
    sessionExists: session => ['demo-Reviewer','demo-Shell'].includes(session),
    fleetP: Promise.resolve({ available: false }), instanceId: () => 'a'.repeat(32), identityMode: 'legacy', localNodeId: () => 'a'.repeat(32) }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const tokenPath = path.join(f.home, 'token'); fs.writeFileSync(tokenPath, 'fixture-token', { mode: 0o600 });
  const broker = createLaunchBroker({ home: f.home }); t.after(() => broker.close());
  const ticket = await broker.issue({ command: out.engine.command, args: out.engine.args,
    env: { ...out.engine.env, MCP_DEVICE: 'reviewer-agent', NEXUSCREW_MCP_SESSION: 'demo-Reviewer' },
    identityChannel: false, supervise: { enabled: false } });
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  process.env.TMUX = '/tmp/fixture-tmux,1,0'; process.env.TMUX_PANE = '%42';
  const messages = []; let captured;
  try {
    assert.equal(await main(['--socket', ticket.socketPath, '--nonce', ticket.nonce], {
      process: new EventEmitter(), spawn: (_command, args, options) => {
        captured = options.env;
        const child = new EventEmitter(); child.kill = () => {};
        setImmediate(async () => {
          try {
            // Fixture of the affected client's choice: without embedded mode,
            // the existing shared daemon supplies its earlier session context.
            const env = args.includes('--no-daemon') ? { ...options.env }
              : { MCP_DEVICE: 'shell-agent', NEXUSCREW_MCP_SESSION: 'demo-Shell', TMUX: '/tmp/fixture-tmux,1,0', TMUX_PANE: '%1' };
            if (mismatch) env.NEXUSCREW_MCP_SESSION = 'demo-Other';
            if (missing) { delete env.NEXUSCREW_MCP_SESSION; delete env.TMUX; delete env.TMUX_PANE; }
            const mcp = createMcpServer({ env, config: { home: f.home, port: server.address().port, tokenPath, tmuxBin: 'fixture-tmux' },
              output: { write: line => messages.push(JSON.parse(line)) }, errlog: () => {},
              execFileImpl: (_binary, args, _opts, done) => done(null, args.includes('%42') ? 'demo-Reviewer' : 'demo-Shell') });
            await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nc_identity', arguments: {} } }));
            await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nc_ask', arguments: { question: 'Callback fixture?' } } }));
            child.emit('exit', 0, null);
          } catch (error) { messages.push({ error: String(error) }); child.emit('exit', 1, null); }
        });
        return child;
      },
    }), 0);
  } finally { for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(captured.TMUX_PANE, '%42'); assert.equal(captured.NEXUSCREW_MCP_SESSION, 'demo-Reviewer');
  if (!messages[1].result.isError) {
    const askId = JSON.parse(messages[1].result.content[0].text).askId;
    const answered = await fetch(`http://127.0.0.1:${server.address().port}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Proceed' }) });
    assert.equal(answered.status, 200); await answered.text();
  }
  return { messages, frames, pastes };
}
test('embedded selection carries the broker child pane to MCP identity and the callback session', async t => {
  const { messages, frames, pastes } = await callback(t);
  const identity = JSON.parse(messages[0].result.content[0].text);
  assert.equal(identity.session, 'demo-Reviewer');
  assert.equal(frames.length, 1); assert.equal(frames[0].session, 'demo-Reviewer');
  assert.equal(pastes.length, 1); assert.equal(pastes[0].session, 'demo-Reviewer');
  assert.match(pastes[0].text, /human reply.*Proceed/);
});
for (const options of [{ mismatch: true }, { missing: true }]) test(`invalid child context refuses callbacks (${JSON.stringify(options)})`, async t => {
  const { frames, messages, pastes } = await callback(t, options);
  assert.equal(frames.length, 0); assert.equal(pastes.length, 0);
  assert.equal(messages[1].result.isError, true);
});
test('a Linux-reporting Termux runtime gets the same embedded containment', t => {
  const f = fixture(t, { platform: 'linux' });
  f.cfg.env = { PREFIX: '/data/data/com.termux/files/usr', HOME: '/data/data/com.termux/files/home' };
  const out = f.resolve(); assert.equal(out.ok, true, out.reason);
  assert.ok(out.engine.args.includes('--no-daemon'));
});
for (const version of ['0.160.0', '0.161.0']) test(`a capable runtime selects embedded mode (${version})`, t => {
  const out = fixture(t, { version }).resolve();
  assert.equal(out.ok, true, out.reason); assert.ok(out.engine.args.includes('--no-daemon'));
});
for (const version of ['0.130.0', '0.131.0-alpha.11']) test(`a runtime before local daemon reuse preserves launch (${version})`, t => {
  const out = fixture(t, { version, flag: false }).resolve();
  assert.equal(out.ok, true, out.reason); assert.equal(out.engine.args.includes('--no-daemon'), false);
});
for (const version of ['0.131.0-alpha.12', '0.131.0', '0.161.0']) test(`a daemon runtime without embedded capability refuses launch (${version})`, t => {
  const out = fixture(t, { version, flag: false }).resolve(); assert.equal(out.ok, false);
});
test('capability probes are cached until the resolved binary modification time changes', t => {
  const f = fixture(t); const log = path.join(f.home, 'probes');
  fs.appendFileSync(f.binary, `require('node:fs').appendFileSync(${JSON.stringify(log)},process.argv.at(-1)+'\\n');\n`);
  assert.equal(f.resolve().ok,true); assert.equal(f.resolve().ok,true);
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,2);
  const st = fs.statSync(f.binary); fs.utimesSync(f.binary, st.atime, new Date(st.mtimeMs+2000));
  assert.equal(f.resolve().ok,true); assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,4);
});
test('static NexusCrew MCP identity overrides are rejected rather than copied from another cell', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.home, '.codex/config.toml'), '[mcp_servers.nexuscrew.env]\nNEXUSCREW_MCP_SESSION="demo-Shell"\n');
  const out = f.resolve(); assert.equal(out.ok, false); assert.match(out.reason, /static context overrides/i);
});
test('an invalid user MCP configuration refuses the embedded launch', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, '.codex/config.toml'), '[broken');
  const out = f.resolve(); assert.equal(out.ok, false); assert.match(out.reason, /valid MCP configuration/i);
});
test('the embedded containment does not invent a NexusCrew server absent from user configuration', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, '.codex/config.toml'), '');
  const out = f.resolve(); assert.equal(out.ok, true, out.reason);
  assert.ok(out.engine.args.includes('--no-daemon'));
  assert.equal(out.engine.args.some(arg => arg.startsWith('mcp_servers.nexuscrew.')), false);
});

test('capability probes use a ten second deadline and refuse process errors', t => {
  const f = fixture(t); const calls = [];
  t.mock.method(require('node:child_process'), 'spawnSync', (command, args, options) => {
    calls.push(options.timeout); return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  });
  const out = f.resolve(); assert.equal(out.ok, false); assert.deepEqual(calls, [10000]);
});

test('a transient capability probe failure is retried on the next launch', t => {
  const f = fixture(t); const childProcess = require('node:child_process');
  const original = childProcess.spawnSync; let first = true;
  t.mock.method(childProcess, 'spawnSync', (...args) => {
    if (first) { first = false; return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }; }
    return original(...args);
  });
  assert.equal(f.resolve().ok, false);
  const second = f.resolve(); assert.equal(second.ok, true, second.reason);
  assert.ok(second.engine.args.includes('--no-daemon'));
});
