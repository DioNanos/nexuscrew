'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');
const KEY = 'CODEX_APP_SERVER_IDENTITY_REQUIRED';
const CONTEXT = ['MCP_DEVICE', 'NEXUSCREW_MCP_SESSION', 'TMUX', 'TMUX_PANE'];
function fixture(t, { client = 'codex-vl', platform = 'linux', mode = 'legacy', ready = false, required, runtimeRequired, staticContext, passthroughRequired, capabilities, version = '0.160.0', flag = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-isolation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  const binary = path.join(home, '.local/bin', client);
  fs.writeFileSync(binary, `#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? ${JSON.stringify('codex-cli '+version)} : ${JSON.stringify(flag ? 'Usage: codex --no-daemon' : 'Usage: codex')});\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.nexuscrew]\ncommand="node"\nargs=["nexuscrew", "mcp"]\nenv_vars=["EXISTING"]\n'+(staticContext ? `[mcp_servers.nexuscrew.env]\n${staticContext}="other-cell"\n` : ''));
  const engine = { id: client+'.native', managed: { client, provider: 'native', model: '', ...(passthroughRequired ? { envPassthrough: [KEY] } : {}) }, ...(required === undefined ? {} : { env: { [KEY]: required } }) };
  const cfg = { home, platform, env: { ...(runtimeRequired === undefined ? {} : { [KEY]: runtimeRequired }) }, nodeExecPath: process.execPath, fleetIdentityMode: mode, ...(ready ? { identityAuthority: { fixture: true } } : {}) };
  return { binary, cfg, engine, resolve: () => resolveManagedEngine(engine, { id: 'Review', prompt: 'bootstrap', ...(capabilities ? { capabilities } : {}) }, cfg) };
}
function isolated(out) {
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.engine.args.filter(arg => arg === '--no-daemon').length, 1);
  assert.ok(out.engine.args.indexOf('--no-daemon') < out.engine.args.indexOf('bootstrap'));
  const entries = out.engine.args.filter(arg => arg.startsWith('mcp_servers.nexuscrew.env_vars='));
  assert.equal(entries.length, 1);
  const names = JSON.parse(entries[0].slice(entries[0].indexOf('=')+1));
  assert.deepEqual(names, ['EXISTING', ...CONTEXT]);
}
for (const client of ['codex', 'codex-vl']) for (const platform of ['linux', 'darwin', 'android']) {
  test(`legacy ${client} is isolated on ${platform} using final launch arguments`, t => {
    const f = fixture(t, { client, platform }); const out = f.resolve(); isolated(out);
    assert.equal(out.engine.info, undefined);
    if (client === 'codex-vl') { assert.equal(out.engine.env[KEY], '0'); assert.equal(out.engine.identityChannel, false); }
  });
  for (const key of CONTEXT) test(`legacy ${client} on ${platform} refuses static ${key}`, t => {
    const out = fixture(t, { client, platform, staticContext: key }).resolve();
    assert.equal(out.ok, false); assert.match(out.reason, /static context overrides/);
  });
}
for (const platform of ['linux','darwin','android']) {
  test(`ready authority preserves the protected VL launch on ${platform}`, t => {
    const out = fixture(t, { platform, mode:'authority', ready:true }).resolve();
    assert.equal(out.ok, true, out.reason); assert.equal(out.engine.env[KEY], '1'); assert.equal(out.engine.identityChannel, true);
    assert.equal(out.engine.args.includes('--no-daemon'), false);
    assert.equal(out.engine.args.some(arg => arg.startsWith('mcp_servers.nexuscrew.env_vars=')), false);
  });
  test(`ready authority with explicit zero isolates VL on ${platform}`, t => {
    const out = fixture(t, { platform, mode:'authority', ready:true, required:'0' }).resolve(); isolated(out);
    assert.equal(out.engine.env[KEY], '0'); assert.equal(out.engine.identityChannel, false);
  });
  test(`authority configuration cannot grant upstream Codex a binding on ${platform}`, t => isolated(fixture(t, { client:'codex', platform, mode:'authority', ready:true }).resolve()));
}
for (const source of ['definition','runtime']) {
  test(`legacy required one from ${source} is refused by the final launch decision`, t => {
    const out = fixture(t, source === 'definition' ? { required:'1' } : { runtimeRequired:'1' }).resolve();
    assert.ok(!out.ok || out.engine.identityAuthorityUnavailable, 'a requested channel is not ready authority');
  });
  for (const required of ['0','1']) test(`unavailable authority cannot be bypassed by ${source} required ${required}`, t => {
    const out = fixture(t, { mode:'authority', ...(source === 'definition' ? { required } : { runtimeRequired:required }) }).resolve();
    assert.ok(!out.ok || out.engine.identityAuthorityUnavailable, 'no launch without configured authority');
  });
}
for (const client of ['codex','codex-vl']) {
  test(`${client} uses the resolved Node shim and refuses a daemon runtime without the flag`, t => {
    const out = fixture(t, { client, flag:false }).resolve(); assert.equal(out.ok, false); assert.match(out.reason, /unsupported/);
  });
  test(`${client} preserves older runtimes without daemon support`, t => {
    const out = fixture(t, { client, flag:false, version:'0.130.0' }).resolve(); assert.equal(out.ok, true, out.reason); assert.equal(out.engine.args.includes('--no-daemon'), false);
  });
}
test('final passthrough cannot turn a legacy isolation decision into a required channel', t => {
  const f = fixture(t, { required:'0', runtimeRequired:'1', passthroughRequired:true });
  const out = f.resolve(); assert.ok(!out.ok || out.engine.env[KEY] === '0', 'final env and channel must agree');
});

// Append only after the current frozen pipeline has completed.
for (const client of ['codex', 'codex-vl']) for (const failure of [{ version: 'unknown' }, { flag: false }]) {
  test(`${client} isolation refusal tells the operator which package and command to update (${JSON.stringify(failure)})`, t => {
    const out = fixture(t, { client, ...failure }).resolve();
    assert.equal(out.ok, false);
    const pkg = client === 'codex' ? '@openai/codex' : '@mmmbuto/codex-vl';
    const minimum = client === 'codex' ? '0.156.0' : '0.156.1-vl.1';
    assert.ok(out.reason.includes(`Update ${pkg} to ${minimum} or later`), out.reason);
    assert.ok(out.reason.includes(`npm install -g ${pkg}@latest`), out.reason);
    assert.match(out.reason, /--version/);
    assert.match(out.reason, /--help/);
    assert.match(out.reason, /--no-daemon/);
  });
}
