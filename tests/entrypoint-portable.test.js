'use strict';
// The published entrypoint must start where /usr/bin/env does not work.
//
// Measured on Android/Termux: `nexuscrew --version` printed
// "/bin/sh: .../usr/bin/nexuscrew: No such file or directory". The shebang
// `#!/usr/bin/env node` only resolves when termux-exec (an LD_PRELOAD that
// rewrites /usr/bin/env) happens to be loaded; a boot script or a tmux session
// started outside a Termux shell does not load it. `node .../bin/nexuscrew.js`
// worked, which is exactly what a launcher is supposed to hide.
//
// The file is therefore a polyglot: `#!/bin/sh` (which exists on Android too)
// with a second line that is a comment to JavaScript and an exec to sh. These
// tests run it the three ways it is really started, and check the two things an
// exec must not break: the stdio of `mcp`, and file descriptors above 2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'nexuscrew.js');
const VERSION = require('../package.json').version;
const NODE = process.execPath;

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nc-${tag}-`));
}

// A PATH that can find `dirname` (which the launcher uses) but NOT node: the
// hermetic version of a boot script environment.
function pathWithoutNode() {
  const dir = tmpdir('path');
  fs.symlinkSync('/usr/bin/dirname', path.join(dir, 'dirname'));
  return dir;
}

function run(args, opts = {}) {
  return spawnSync('/bin/sh', [ENTRY, ...args], {
    encoding: 'utf8', timeout: 30000, ...opts,
  });
}

test('the entrypoint is valid in both languages it is written in', () => {
  const asSh = spawnSync('/bin/sh', ['-n', ENTRY], { encoding: 'utf8' });
  assert.equal(asSh.status, 0, `sh -n rejected the file: ${asSh.stderr}`);
  const asJs = spawnSync(NODE, ['--check', ENTRY], { encoding: 'utf8' });
  assert.equal(asJs.status, 0, `node --check rejected the file: ${asJs.stderr}`);
});

test('started as a shell script (what Android does) it runs and prints the version', () => {
  const out = run(['--version']);
  assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
  assert.match(out.stdout, new RegExp(VERSION));
});

test('with no node in PATH it finds the sibling node next to the launcher', () => {
  const dir = pathWithoutNode();
  const launcher = path.join(dir, 'nexuscrew');
  fs.symlinkSync(ENTRY, launcher);
  fs.symlinkSync(NODE, path.join(dir, 'node'));
  const out = spawnSync('/bin/sh', [launcher, '--version'], {
    encoding: 'utf8', timeout: 30000, env: { PATH: dir, HOME: tmpdir('home') },
  });
  assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
  assert.match(out.stdout, new RegExp(VERSION));
});

test('the sibling wins over PATH (it is the node the launcher was installed with)', () => {
  const dir = tmpdir('sibling');
  const launcher = path.join(dir, 'nexuscrew');
  fs.symlinkSync(ENTRY, launcher);
  // A sibling `node` that answers with a marker: if PATH's node had been used
  // instead, the output would be a version number.
  const fake = path.join(dir, 'node');
  fs.writeFileSync(fake, '#!/bin/sh\necho SIBLING-NODE-WINS\n', { mode: 0o755 });
  const out = spawnSync('/bin/sh', [launcher, '--version'], {
    encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: tmpdir('home') },
  });
  assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
  assert.match(out.stdout, /SIBLING-NODE-WINS/);
});

test('with no node at all it fails with exit 127 and says why', () => {
  const dir = pathWithoutNode();
  const launcher = path.join(dir, 'nexuscrew');
  fs.symlinkSync(ENTRY, launcher);
  const out = spawnSync('/bin/sh', [launcher, '--version'], {
    encoding: 'utf8', timeout: 30000, env: { PATH: dir, HOME: tmpdir('home') },
  });
  assert.equal(out.status, 127, `expected 127, got ${out.status}: ${out.stderr}`);
  assert.match(out.stderr, /node not found next to the launcher or in PATH/);
});

test('the three ways to start it print the same version', () => {
  const viaShell = run(['--version']);
  const viaShebang = spawnSync(ENTRY, ['--version'], { encoding: 'utf8', timeout: 30000 });
  const viaNode = spawnSync(NODE, [ENTRY, '--version'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(viaShell.status, 0, viaShell.stderr);
  assert.equal(viaShebang.status, 0, viaShebang.stderr);
  assert.equal(viaNode.status, 0, viaNode.stderr);
  const clean = (s) => s.trim();
  assert.equal(clean(viaShebang.stdout), clean(viaShell.stdout));
  assert.equal(clean(viaNode.stdout), clean(viaShell.stdout));
  assert.match(clean(viaShell.stdout), new RegExp(VERSION));
});

test('`mcp` over stdio still answers after the exec', async () => {
  const home = tmpdir('home');
  const child = spawn('/bin/sh', [ENTRY, 'mcp'], {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const line = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write(`${line}\n`);
  const answered = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    const check = () => {
      if (out.includes('"serverInfo"')) { clearTimeout(timer); resolve(true); }
    };
    child.stdout.on('data', check);
  });
  child.stdin.end();
  child.kill();
  assert.ok(answered, `no initialize answer over stdio: ${JSON.stringify(out.slice(0, 200))}`);
  assert.match(out, new RegExp(VERSION));
});

test('a file descriptor above 2 survives the exec', () => {
  // The exec is the point of this file, so the descriptor is checked through the
  // real header with a test payload: whatever starts the launcher may have fd 3
  // open (the cell launchers do), and exec must not close it.
  const dir = tmpdir('fd');
  const entryLines = fs.readFileSync(ENTRY, 'utf8').split('\n');
  const header = `${entryLines[0]}\n${entryLines[1]}\n`;
  assert.match(entryLines[0], /^#!\/bin\/sh/, 'first line must be the shell shebang');
  const payload = path.join(dir, 'payload.js');
  const marker = path.join(dir, 'fd3-marker.txt');
  fs.writeFileSync(payload, `${header}'use strict';\n`
    + "const fs = require('node:fs');\n"
    + "fs.fstatSync(3);\n"
    + `fs.writeSync(3, 'FD3-ALIVE\\n');\n`, { mode: 0o755 });

  const fd3 = fs.openSync(marker, 'w');
  const out = spawnSync('/bin/sh', [payload], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe', fd3] });
  fs.closeSync(fd3);
  assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'FD3-ALIVE');
});

test('the packed file keeps the executable bit', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout)[0];
  const entry = report.files.find((f) => f.path === 'bin/nexuscrew.js');
  assert.ok(entry, `bin/nexuscrew.js is not in the package: ${report.files.map((f) => f.path).join(', ')}`);
  assert.ok((entry.mode & 0o111) !== 0, `packed without the executable bit: mode ${entry.mode.toString(8)}`);
});
