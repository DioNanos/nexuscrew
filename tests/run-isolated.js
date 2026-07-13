'use strict';

// Official test entrypoint.  Besides per-worker HOME isolation, this enforces
// the most important containment invariant: a passing suite may not leave a
// detached NexusCrew tunnel supervisor alive.  Any owned leak is terminated
// by its exact pid/cmd metadata and still makes the suite fail.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-tests-'));
const tmuxRoot = path.join(root, 'tmux');
fs.mkdirSync(tmuxRoot, { recursive: true, mode: 0o700 });
const bootstrap = path.join(__dirname, 'isolated-home.cjs');
const testFiles = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

function allPidfiles(dir, found = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return found; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) allPidfiles(target, found);
    else if (entry.isFile() && entry.name.endsWith('.pid') && path.basename(path.dirname(target)) === 'tunnels') found.push(target);
  }
  return found;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function terminateOwnedLeak(pidPath, meta) {
  if (!meta || !pidf.isAlive(meta)) return false;
  const live = pidf.readCmdline(meta.pid);
  if (!live.includes('tunnel-supervisor.js')) return false;

  try { process.kill(meta.pid, 'SIGTERM'); } catch (_) {}
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && pidf.pidExists(meta.pid)) await delay(50);
  if (pidf.pidExists(meta.pid)) {
    const still = pidf.readCmdline(meta.pid);
    if (still.includes('tunnel-supervisor.js')) {
      try { process.kill(meta.pid, 'SIGKILL'); } catch (_) {}
    }
  }
  pidf.removePidfile(pidPath);
  return true;
}

async function main() {
  const childEnv = {
    ...process.env,
    NEXUSCREW_TEST_HOME_ROOT: root,
    NEXUSCREW_TEST_TMUX_ROOT: tmuxRoot,
    NEXUSCREW_AUTO_UPDATE: '0',
    TMUX_TMPDIR: tmuxRoot,
  };
  // Never let a test client inherit the operator's live tmux socket.
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  const child = spawn(process.execPath, ['--require', bootstrap, '--test', ...process.argv.slice(2), ...testFiles], {
    cwd: path.join(__dirname, '..'),
    env: childEnv,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (value) => resolve(Number.isInteger(value) ? value : 1));
  });

  const leaked = [];
  for (const pidPath of allPidfiles(root)) {
    const meta = pidf.readPidfile(pidPath);
    if (await terminateOwnedLeak(pidPath, meta)) leaked.push({ pid: meta.pid, pidPath });
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (leaked.length) {
    process.stderr.write(`\nNexusCrew test containment failure: ${leaked.length} detached tunnel supervisor(s) were cleaned up.\n`);
    process.exit(1);
  }
  process.exit(code);
}

main().catch((error) => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
