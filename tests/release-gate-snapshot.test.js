'use strict';
// The release gate measures the qualified artifacts (four VL binaries and the
// node interpreter) before the jobs and again after each of them; a difference
// must refuse the run. These tests extract the three snapshot functions from
// the script and drive them with a fake world: the positive case passes, the
// negative one (an artifact changed between the snapshot and the check) is
// refused with a message that names the two fingerprints.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const GATE = path.join(REPO, 'scripts', 'release-gate.sh');

function estraiFunzioni() {
  const testo = fs.readFileSync(GATE, 'utf8');
  const inizio = testo.indexOf('snapshot_fingerprints() {');
  const fine = testo.indexOf('# <<< gate-snapshot');
  assert.ok(inizio > 0 && fine > inizio, 'the snapshot block is not in the expected shape');
  return testo.slice(inizio, fine);
}

function harness(dir) {
  return `#!/bin/bash
set -uo pipefail
die() { printf 'REFUSED (%s): %s\\n' "$1" "$2" >&2; exit 3; }
note() { :; }
sha_of() { sha256sum "$1" | awk '{print $1}'; }
NEW_BIN="${dir}/new"; OLD_BIN="${dir}/old"; STATUS_BIN="${dir}/status"
CLIENT_BIN="${dir}/client"; GATE_NODE="${dir}/node"
FUTURE_MANIFEST="${dir}/manifest"
FILES=(one two); FUTURE_FILES=(three)
`;
}

function prepara(dir) {
  for (const nome of ['new', 'old', 'status', 'client', 'node', 'manifest']) {
    fs.writeFileSync(path.join(dir, nome), `contenuto-${nome}\n`);
  }
  // The snapshot reads HEAD, the tree and the dirty count from the worktree:
  // the fixtures live outside it, so the clean repository is a separate one.
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.keep'), 'x\n');
  spawnSync('git', ['add', '.keep'], { cwd: repo });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: repo });
  return repo;
}

function corri(dir, repo, scenario) {
  const script = `${harness(dir)}
${estraiFunzioni()}
SNAP_COMMIT=$(git rev-parse HEAD 2>/dev/null || true)
SNAP_TREE=$(git rev-parse 'HEAD^{tree}' 2>/dev/null || true)
SNAP_MANIFEST=$(sha_of "$FUTURE_MANIFEST")
SNAP_RELEASE=$(printf '%s\\n' "\${FILES[@]}" | sha256sum | awk '{print $1}')
SNAP_FUTURE=$(printf '%s\\n' "\${FUTURE_FILES[@]}" | sha256sum | awk '{print $1}')
snapshot_fingerprints
SNAP_ARTIFACTS=$SNAP_ARTIFACTS_NOW
${scenario}
`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000, cwd: repo });
}

test('gate snapshot: unchanged artifacts keep the run alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gate-snap-ok-'));
  try {
    const repo = prepara(dir);
    const esito = corri(dir, repo, "snapshot_same 'the final verdict'; echo SAME");
    assert.equal(esito.status, 0, esito.stderr);
    assert.match(esito.stdout, /SAME/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate snapshot: an artifact changed after the snapshot is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gate-snap-ko-'));
  try {
    const repo = prepara(dir);
    const esito = corri(dir, repo,
      `printf 'diverso\\n' > "${dir}/new"; snapshot_same 'the final verdict'; echo SAME`);
    assert.notEqual(esito.status, 0, 'the gate must refuse');
    assert.match(esito.stderr, /REFUSED \(snapshot\)/);
    assert.match(esito.stderr, /qualified artifacts or the node interpreter changed between the snapshot and the final verdict/);
    assert.doesNotMatch(esito.stdout, /SAME/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate snapshot: an unreadable artifact is a refusal, not an empty fingerprint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gate-snap-miss-'));
  try {
    const repo = prepara(dir);
    const esito = corri(dir, repo,
      `rm -f "${dir}/node"; snapshot_same 'the final verdict'; echo SAME`);
    assert.notEqual(esito.status, 0);
    assert.match(esito.stderr, /REFUSED \(snapshot\)/);
    assert.match(esito.stderr, /unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
