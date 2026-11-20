'use strict';
// Named regressions for the managed qwen gate hardening. Each test pins ONE
// behavior a later refactor could silently regress: the retired-field check
// must read OWN presence only (an inherited prototype key is not a
// declaration, whatever operator detects the field), and every identity read
// of the binary is a mandatory checkpoint — a stat that turns unreadable in
// the middle of the version probe must refuse, never fall back to an older
// snapshot of the file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeManagedSpec, describeManaged,
} = require('../lib/fleet/managed.js');

const QWEN = { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' };
const PROBE_OK = { stdout: '0.27.2\n', stderr: '' };
// Reduced REAL fixture: measured `--help` output of the 0.x CLI, option lines
// and policy values verbatim, so the dialect check has what it requires.
const HELP_OK = [
  'Usage: qwen [options] [command]',
  'Options:',
  '  -m, --model                           Model  [string]',
  '  -i, --prompt-interactive              Execute the provided prompt and continue in interactive mode  [string]',
  '      --system-prompt                   Override the main session system prompt for this run. Can be combined with --append-system-prompt.  [string]',
  '      --append-system-prompt            Append instructions to the default session system prompt for this run. Can be combined with --system-prompt.  [string]',
  '  -y, --yolo                            Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]',
  '      --approval-mode                   Set the approval mode: plan (Analyze only, do not modify files or execute commands), default (Require approval for file edits or shell commands), auto-edit (Automatically approve file edits), auto (LLM classifier auto-approves safe actions, blocks risky ones), yolo (Automatically approve all tools)  [string] [choices: "plan", "default", "auto-edit", "auto", "yolo"]',
].join('\n');

function homeWithQwen() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqwenreg-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'qwen');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

function cfgConProbe(home) {
  return {
    home, platform: 'linux', env: {},
    qwenVersionProbe: () => PROBE_OK,
    qwenHelpProbe: () => HELP_OK,
  };
}

test('managed spec: a retired qwen field inherited from the prototype is never read as a declared own field', () => {
  const home = homeWithQwen();
  try {
    // The prototype carries a RETIRED field with a real value: property
    // lookup finds it, `in` reports it, Object.keys does not. None of that
    // is a declaration by the spec author: only own presence rejects, so
    // the valid own keys must still configure on the PATH candidate.
    const spec = Object.assign(Object.create({ qwenBinary: '/opt/qwen/qwen-preview' }), QWEN);
    assert.ok('qwenBinary' in spec, 'precondition: the field is visible on the prototype chain');
    assert.equal(Object.keys(spec).includes('qwenBinary'), false, 'precondition: not an own enumerable key');

    const issues = [];
    const normalized = normalizeManagedSpec(spec, { onIssue: (i) => issues.push(i) });
    assert.notEqual(normalized, null, 'inherited presence is not a declaration: normalize accepts');
    assert.equal(issues.length, 0, `no retired-field issue expected: ${JSON.stringify(issues)}`);

    const d = describeManaged(spec, cfgConProbe(home));
    assert.equal(d.configured, true, `describe configures on the PATH candidate, no rejection for the inherited field (${d.reason})`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('managed spec: a retired qwen field inherited from the prototype is ignored even when its value is undefined', () => {
  const home = homeWithQwen();
  try {
    // Same guard on the value side: an inherited undefined must neither
    // reject (presence is not own) nor be confused with an OWN undefined
    // declaration, which stays rejected by its dedicated regression.
    const spec = Object.assign(Object.create({ qwenBinary: undefined }), QWEN);
    const normalized = normalizeManagedSpec(spec);
    assert.notEqual(normalized, null, 'an INHERITED undefined is not a declaration: normalize accepts');
    const d = describeManaged(spec, cfgConProbe(home));
    assert.equal(d.configured, true, `describe configures (${d.reason})`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen gate: a binary stat that turns unreadable between the identity reads of the version probe refuses without a positive verdict or cache', () => {
  // Identity reads of the binary inside one gate run: #1 initial identity,
  // #2 before the version probe, #3 after it, #4 after the help probe.
  // Reads #2 and #3 are the mid-probe checkpoint, and read #4 is the
  // post-help checkpoint — the exact read whose fallback to the previous
  // identity was the original proven defect. Failing any of #2, #3 or #4
  // must refuse immediately: falling back to the previous readable snapshot
  // is exactly the regression pinned here (a positive verdict would attest
  // a file that could not be read at qualification time).
  for (const failingRead of [2, 3, 4]) {
    const home = homeWithQwen();
    try {
      const bin = path.join(home, '.local', 'bin', 'qwen');
      const realStat = fs.statSync;
      let reads = 0;
      fs.statSync = function (...a) {
        if (path.resolve(String(a[0])) === path.resolve(bin)) {
          reads += 1;
          if (reads === failingRead) {
            const e = new Error('EIO: synthetic');
            e.code = 'EIO';
            throw e;
          }
        }
        return realStat.apply(this, a);
      };
      const cfg = cfgConProbe(home);
      let d = null;
      try {
        d = describeManaged(QWEN, cfg);
      } finally { fs.statSync = realStat; }
      assert.equal(d.configured, false, `unreadable read #${failingRead}: refusal, no fallback on the previous identity (${d.reason})`);
      assert.match(String(d.reason), /identit|verificabil/i, `read #${failingRead}: the reason mentions the unverifiable identity (${d.reason})`);
      const positives = [...(cfg._qwenProbeCache || new Map()).values()].filter((v) => v && v.ok);
      assert.equal(positives.length, 0, `read #${failingRead}: no positive verdict in cache`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
