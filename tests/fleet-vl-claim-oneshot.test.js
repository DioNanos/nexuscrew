'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'lib', 'fleet', 'vl-claim-section.js');

function corpo(dir) {
  return `${JSON.stringify({
    v: 1, op: 'claim', requestId: '11'.repeat(8), root: path.join(dir, 'root'),
    launchId: '22'.repeat(8), ownerInstanceId: 'owner', cellId: 'cell', claimsDir: dir,
    lockPath: path.join(dir, 'root.lock'), sectionBudgetMs: 1000,
  })}\n`;
}

function lancia(dir, invia) {
  const lock = path.join(dir, 'root.lock');
  fs.writeFileSync(lock, '', { mode: 0o600 });
  const child = spawn('/usr/bin/flock', [
    '-F', '-x', '-w', '2', '--', lock, process.execPath, HELPER,
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  let text = '';
  child.stdout.on('data', (b) => { text += b; });
  const close = new Promise((resolve) => child.on('close', resolve));
  invia(child, corpo(dir));
  return close.then(() => ({
    text: text.trim(),
    lease: fs.readdirSync(dir).some((n) => n.endsWith('.lease')),
  }));
}

test('due frame non creano una lease, neanche se arrivano in chunk diversi', async () => {
  const wholeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-oneshot-whole-'));
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-oneshot-split-'));
  const whole = await lancia(wholeDir, (child, riga) => child.stdin.end(`${riga}{}\n`));
  const split = await lancia(splitDir, (child, riga) => {
    child.stdin.write(riga);
    setTimeout(() => child.stdin.end('{}\n'), 40);
  });
  fs.rmSync(wholeDir, { recursive: true, force: true });
  fs.rmSync(splitDir, { recursive: true, force: true });
  assert.equal(whole.lease, false, whole.text);
  assert.equal(split.lease, false, split.text);
});
