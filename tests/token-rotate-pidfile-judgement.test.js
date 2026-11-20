'use strict';
// `token rotate` with no managed service only WARNS about a manual server
// that may still hold the old token. The warning follows the evidence-positive
// judgement: "not active" needs proof (ESRCH); an unverifiable record is a
// warning, never a reassurance; an alive one names the pid. The record is
// never touched. The runtime owner is resolved first (a record that is alive
// or unverifiable makes the portable runtime "running" and token rotate
// restarts it), so the warning branch is reached when the first look proves
// the runtime stopped; a second look that disagrees (the race the branch
// exists for) is driven here with a probe that changes answer after the first
// call. Temporary homes only, no real process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pidf = require('../lib/cli/pidfile.js');
const { tokenRotate } = require('../lib/cli/commands.js');

function setup(t, pid, killImpl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-trj-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"port":41822}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'token'), 'SECRETTOKEN12345\n', { mode: 0o600 });
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, pid, 'node nexuscrew serve');
  const before = fs.readFileSync(pidPath);
  const lines = [];
  const r = tokenRotate({
    home, platform: 'linux', log: (m) => lines.push(String(m)),
    execImpl: () => { throw new Error('inactive'); },
    pidImpl: { killImpl },
  });
  assert.equal(r.rotated, true);
  assert.deepEqual(fs.readFileSync(pidPath), before, 'the warning never touches the record');
  return lines.join('\n');
}

const probeError = (code) => { const e = new Error(`probe ${code}`); e.code = code; return e; };
// First probe: the process is gone (owner resolves to stopped). Later probes
// answer `dopo` (null = the pid exists).
const poiCambia = (dopo) => {
  let n = 0;
  return () => {
    n += 1;
    if (n === 1) throw probeError('ESRCH');
    if (dopo) throw probeError(dopo);
    return true;
  };
};

test('token rotate: a record that turns unverifiable after the first look is a warning, never "service not active"', (t) => {
  const out = setup(t, 424242, poiCambia('EPERM'));
  assert.match(out, /WARNING.*unverifiable/);
  assert.doesNotMatch(out, /service not active/);
});

test('token rotate: dead pid proven by ESRCH reports not active', (t) => {
  const out = setup(t, 424242, () => { throw probeError('ESRCH'); });
  assert.match(out, /service not active/);
  assert.doesNotMatch(out, /WARNING/);
});

test('token rotate: a manual server that is alive at the second look names the pid in the warning', (t) => {
  const out = setup(t, process.pid, poiCambia(null));
  assert.match(out, new RegExp(`WARNING.*manual server active \\(pid ${process.pid}\\)`));
});
