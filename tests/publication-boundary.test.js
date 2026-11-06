'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(ROOT, 'publish', 'build-git-surface.sh');

function runBuilder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-boundary-'));
  const out = path.join(dir, 'public');
  const manifest = path.join(dir, 'manifest.json');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(BUILDER, [sha, out, manifest], { cwd: ROOT, encoding: 'utf8' });
  return { dir, out, manifest, result };
}

function sourceSha() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
}

function runVerifier({ staging, exclude, manifest, env = process.env, source, rulesPath } = {}) {
  const invocation = path.join(path.dirname(manifest), 'invocation.argv');
  fs.writeFileSync(invocation, 'negative-control\0');
  return spawnSync(process.execPath, [
    path.join(ROOT, 'publish', 'verify-git-surface.js'), source || sourceSha(), staging, manifest,
    exclude, path.join(ROOT, 'publish', 'build-git-surface.sh'),
    rulesPath || path.join(ROOT, 'publish', 'public-surface-rules.json'),
    path.join(ROOT, 'publish', 'verify-git-surface.js'), invocation,
  ], { cwd: ROOT, encoding: 'utf8', env });
}

function archiveSource(staging) {
  const archive = path.join(path.dirname(staging), 'source.tar');
  const made = spawnSync('git', ['archive', '--format=tar', sourceSha(), '-o', archive], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr || made.stdout);
  const unpacked = spawnSync('tar', ['-x', '-f', archive, '-C', staging], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr || unpacked.stdout);
}

test('builder creates a verified public tree and provenance manifest', () => {
  const { dir, out, manifest, result } = runBuilder();
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(out), 'public tree missing');
    assert.ok(fs.existsSync(manifest), 'provenance manifest missing');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.match(data.source.commitSha, /^[0-9a-f]{40}$/);
    assert.match(data.outputGit.publicTreeId, /^[0-9a-f]{40}$/);
    assert.match(data.builder.sha256, /^[0-9a-f]{64}$/);
    assert.match(data.excludeList.sha256, /^[0-9a-f]{64}$/);
    assert.ok(data.checks.scanned > 0, 'verifier scanned no files');
    assert.equal(data.policy.deletionOnly, true);
    assert.equal(data.policy.parentPolicy, 'root');
    assert.deepEqual(data.outputGit.parents, []);
    assert.deepEqual(data.delta.transformed, []);
    assert.deepEqual(data.delta.unexpectedMissing, []);
    assert.deepEqual(data.delta.unexpectedAdded, []);
    assert.equal(data.checks.result, 'PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('public tree excludes the guard, its private rules, and publication helpers', () => {
  const { dir, out, result } = runBuilder();
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const rel of [
      'tests/published-tree-is-clean.test.js',
      'tests/published-tree-clean-rules.json',
      'tools/extract-payload-context.py',
      'publish/',
    ]) {
      assert.equal(fs.existsSync(path.join(out, rel)), false, `${rel} leaked into public tree`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic rerun reproduces the same Git tree and delta', () => {
  const first = runBuilder();
  const second = runBuilder();
  try {
    assert.equal(first.result.status, 0, first.result.stderr || first.result.stdout);
    assert.equal(second.result.status, 0, second.result.stderr || second.result.stdout);
    const a = JSON.parse(fs.readFileSync(first.manifest, 'utf8'));
    const b = JSON.parse(fs.readFileSync(second.manifest, 'utf8'));
    assert.equal(a.outputGit.publicTreeId, b.outputGit.publicTreeId);
    assert.equal(a.outputGit.publicCommitId, b.outputGit.publicCommitId);
    assert.deepEqual(a.delta, b.delta);
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(second.dir, { recursive: true, force: true });
  }
});

test('negative control: removing the publish exclusion fails at the boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-negative-exclude-'));
  try {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    archiveSource(staging);
    const exclude = path.join(dir, 'exclude.txt');
    fs.writeFileSync(exclude, fs.readFileSync(path.join(ROOT, 'publish', 'git-surface-exclude.txt'), 'utf8')
      .split(/\r?\n/).filter((line) => line.trim() !== 'publish/').join('\n'));
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({ staging, exclude, manifest });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(manifest), false);
    assert.match(result.stderr, /object equation fallita|contenuto\/percorso vietato/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('negative control: dead strings scanner fails closed without output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-negative-scanner-'));
  try {
    const fakeBin = path.join(dir, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'strings'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
    // The public tree may hold no binary at all, so the control carries its own.
    const payload = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from('plain ascii payload\0'), Buffer.from([0xff])]);
    const files = [{ rel: 'assets/blob.bin', data: payload }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(manifest), false);
    assert.match(result.stderr, /scanner binari exited 77|scanner binari non disponibile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('negative control: altered source SHA fails before producing artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-negative-sha-'));
  try {
    const out = path.join(dir, 'public');
    const manifest = path.join(dir, 'manifest.json');
    const result = spawnSync(BUILDER, ['0000000000000000000000000000000000000000', out, manifest], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('negative control: empty staging fails the object equation before manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-negative-empty-'));
  try {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    const exclude = path.join(dir, 'exclude.txt');
    fs.copyFileSync(path.join(ROOT, 'publish', 'git-surface-exclude.txt'), exclude);
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({ staging, exclude, manifest });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(manifest), false);
    assert.match(result.stderr, /object equation fallita|public tree vuoto/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- workcodes (surface scan): the verifier must enforce the workcode bundle ---

// Builds a throwaway commit whose tree contains exactly `files` ([{ rel, data }]),
// so the object equation can be satisfied by a staging with the same contents.
function syntheticSource(files) {
  const root = {};
  for (const { rel, data } of files) {
    const parts = rel.split('/');
    let level = root;
    for (const part of parts.slice(0, -1)) {
      level[part] = level[part] || {};
      level = level[part];
    }
    level[parts.at(-1)] = { data };
  }
  const writeTree = (level) => {
    const entries = Object.entries(level).map(([name, value]) => {
      if (value.data !== undefined) {
        const hash = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: ROOT, input: Buffer.from(value.data) });
        assert.equal(hash.status, 0, hash.stderr.toString());
        return `100644 blob ${hash.stdout.toString().trim()}\t${name}`;
      }
      return `040000 tree ${writeTree(value)}\t${name}`;
    });
    const tree = spawnSync('git', ['mktree'], { cwd: ROOT, input: entries.join('\n'), encoding: 'utf8' });
    assert.equal(tree.status, 0, tree.stderr);
    return tree.stdout.trim();
  };
  const commit = spawnSync('git', ['commit-tree', writeTree(root)], {
    cwd: ROOT,
    input: 'synthetic surface fixture\n',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'NexusCrew Test', GIT_AUTHOR_EMAIL: 'test@nexuscrew.invalid',
      GIT_COMMITTER_NAME: 'NexusCrew Test', GIT_COMMITTER_EMAIL: 'test@nexuscrew.invalid',
    },
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  return commit.stdout.trim();
}

function syntheticStaging(dir, files) {
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  for (const { rel, data } of files) {
    const target = path.join(staging, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return staging;
}

function emptyExclude(dir) {
  const exclude = path.join(dir, 'exclude.txt');
  fs.writeFileSync(exclude, '# synthetic surface: nothing excluded\n');
  return exclude;
}

function rulesWithoutWorkcodes(dir) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'publish', 'public-surface-rules.json'), 'utf8'));
  delete base.workcodes;
  const rulesPath = path.join(dir, 'rules-without-workcodes.json');
  fs.writeFileSync(rulesPath, JSON.stringify(base));
  return rulesPath;
}

test('workcodes: a rule bundle without the workcodes section is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-missing-'));
  try {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    const exclude = emptyExclude(dir);
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({ staging, exclude, manifest, rulesPath: rulesWithoutWorkcodes(dir) });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /rule bundle non valido/);
    assert.match(result.stderr, /workcodes/);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a work-order code in a comment fails the verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-deny-'));
  try {
    const files = [{ rel: 'src/demo.js', data: '// per-node groups (D-392): polled separately\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /internal work-order code/);
    assert.match(result.stderr, /D-392/);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a family match that no allow rule names fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-closed-'));
  try {
    const files = [{ rel: 'src/demo.js', data: '// V-77 drafted overnight, not in any list\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /fail-closed/);
    assert.match(result.stderr, /V-77/);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: short specification labels, lock files and the dist prefix pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-allow-'));
  try {
    const files = [
      { rel: 'src/short-labels.js', data: '// R25 and IC1.1 are short spec labels; M12 4v10 is path data; T0 is a clock\n' },
      { rel: 'frontend/package-lock.json', data: '"integrity": "sha512-ab/D123/cd+V-99"\n' },
      { rel: 'frontend/dist/bundle.js', data: '// D-392 under the dist prefix, not scanned\n' },
      { rel: 'docs/audit-note.md', data: 'Run the dependency audit before every release.\n' },
      { rel: 'skills/cellforge/SKILL.md', data: 'An audit answers one question.\n' },
    ];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(manifest), 'manifest missing on allow path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, line, reason, token] of [
  ['audit provenance', '// found by an independent audit, see the report\n', /internal audit provenance/, /audit/],
  ['plan reference', '// formatting as per the plan, come da piano C3\n', /internal plan or mandate reference/, /piano/],
  ['revision reference', '// R27 rev3: the fleet is off\n', /internal contract revision reference/, /rev3/],
  ['section with a document name', '// see the contratto rev6 \u00a72.1 for the rule\n', /internal document section reference|internal contract revision reference/, /\u00a72\.1|rev6/],
  ['work-order variant', '// tracked as D447 in the tracker\n', /internal work-order code/, /D447/],
  ['legacy work-order prefix', '// scope NC-E, see below\n', /internal work-order code/, /NC-E/],
]) {
  test(`workcodes: ${name} fails the verifier`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-fam-'));
    try {
      const files = [{ rel: 'src/demo.js', data: line }];
      const manifest = path.join(dir, 'manifest.json');
      const result = runVerifier({
        staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
      });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, reason);
      assert.match(result.stderr, token);
      assert.equal(fs.existsSync(manifest), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- audit provenance and plan references: never exempt, whatever the file ---

const PROBE_CASES = [
  ['an audit hash in the README', 'README.md', 'Found by audit 43bb3e9e last week.\n'],
  ['an audit hash in the CHANGELOG', 'CHANGELOG.md', '- fixed (audit 43bb3e9e)\n'],
  ['an audit hash in a skill', 'skills/nexuscrew/SKILL.md', 'Rule from audit 43bb3e9e.\n'],
  ['an audit hash in a skill that may talk about audits', 'skills/cellforge/SKILL.md', 'An audit answers one question (reaudit 2a05db2).\n'],
  ['an audit hash on a line that mentions npm audit', 'frontend/src/lib/probe.js', '// npm audit; auditor 43bb3e9e\n'],
  ['an audit hash in a file named after the auditor', 'tests/auditor-probe.test.js', "// audit 3405df0: regression\n"],
  ['AUDIT in capitals with a hash, in a skill that may talk about audits', 'skills/cellforge/SKILL.md', 'AUDIT 43bb3e9e\n'],
  ['an audit with an upper-case hash, in a skill that may talk about audits', 'skills/cellforge/SKILL.md', 'audit 43BB3E9E\n'],
  ['AUDIT in capitals with an upper-case hash, in a skill that may talk about audits', 'skills/cellforge/SKILL.md', 'AUDIT 43BB3E9E\n'],
  ['Audit with a mixed-case hash in the README', 'README.md', 'Audit 43Bb3E9e\n'],
  ['a PIANO reference in capitals', 'README.md', 'PIANO V3 :114-117\n'],
  ['a numbered plan with line references', 'README.md', 'See piano v3 :114-117, :222-226 for the rule.\n'],
  ['a plan reference in a workflow header', '.github/workflows/gate.yml', '# gate (piano v3 :114-117).\n'],
  ['a revision with line references', 'docs/note.md', 'contratto rev6 :88-91\n'],
];

for (const [name, rel, data] of PROBE_CASES) {
  test(`provenance: ${name} fails the verifier`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-prov-'));
    try {
      const files = [{ rel, data }];
      const manifest = path.join(dir, 'manifest.json');
      const result = runVerifier({
        staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
      });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /audit hash or plan reference|internal plan or mandate|internal audit provenance/);
      assert.equal(fs.existsSync(manifest), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('provenance: the legitimate uses of the word audit still pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-prov-ok-'));
  try {
    const files = [
      { rel: 'README.md', data: 'Run `npm audit` and keep the audit trail. A dependency audit is not a release gate.\n' },
      { rel: 'CHANGELOG.md', data: '- New skill (create, modify and audit a cell)\n' },
      { rel: 'skills/cellforge/SKILL.md', data: 'An audit answers one question: does the cell exist completely?\nAUDIT is also the heading word; a defaced page and a decade old cafe stay plain words.\n' },
      { rel: 'src/labels.js', data: '// R25 and IC1.1 stay allowed; version 0.9.64 and commit 43bb3e9e are plain data\n' },
    ];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provenance: a skill that is not about audits cannot use the word audit either', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-prov-skill-'));
  try {
    const files = [{ rel: 'skills/nexuscrew/SKILL.md', data: 'This rule comes from an audit of the first release.\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /internal audit provenance/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provenance: the family has no exemption of any kind', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'publish', 'public-surface-rules.json'), 'utf8'));
  const family = rules.workcodes.families.PROVENANCE;
  assert.ok(family, 'the PROVENANCE family must exist');
  assert.deepEqual(Object.keys(family).sort(), ['flags', 'reason', 'source'], 'no allowLineRe, allowPathPrefix or other escape');
  assert.ok(family.flags.includes('i'), 'the family is case-insensitive');
  assert.deepEqual(rules.workcodes.allowLineRe, [], 'no global line exemption that could hide a provenance reference');
  // The AUDIT exemptions are bounded to what legitimately talks about audits, never README, CHANGELOG or every skill.
  const prefixes = rules.workcodes.families.AUDIT.allowPathPrefix;
  for (const wide of ['README.md', 'CHANGELOG.md', 'skills/']) assert.ok(!prefixes.includes(wide), `${wide} must not be exempt as a whole`);
});

// Le fixture dei test nominavano i giri di lavoro in minuscolo (`nc-d582-…`,
// `sentinella-d582`, il vecchio nome di un file di test). I codici in
// MAIUSCOLO erano coperti; queste forme no, e il rilevatore le contava zero.
// Sono un punto cieco suo, non un'assenza nel repository.
test('workcodes: a lowercase work-order prefix in a fixture name fails the verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-lower-'));
  try {
    const files = [{ rel: 'tests/demo.test.js', data: "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d582-proc-'));\n" }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /internal work-order code in a fixture or file name/);
    assert.match(result.stderr, /nc-d582-proc-/);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a tmux sentinel named after a work order fails the verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-sentinel-'));
  try {
    const files = [{ rel: 'tests/demo.test.js', data: "const nome = 'sentinella-d582';\n" }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /sentinella-d582/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: an old test file name carrying a work order fails the verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-oldname-'));
  try {
    const files = [{ rel: 'tests/demo.test.js', data: '// provato con seam in fleet-vl-bootstrap-d558-runtime.test.js\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /fleet-vl-bootstrap-d558-runtime/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a code without the separator in a fixture name fails the verifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-nosep-'));
  try {
    const files = [{ rel: 'tests/demo.test.js', data: "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd6home-'));\n" }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ncd6home-/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Il codice puo' stare nel NOME del file invece che nel contenuto: un nome si
// legge dall'indice senza aprire nulla, e il filtro sul testo non lo vede.
test('workcodes: a code in the file name fails the verifier with clean content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-pathname-'));
  try {
    const files = [{ rel: 'tests/nc-d582-clean.test.js', data: 'const x = 1;\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /internal work-order code in a file name/);
    assert.match(result.stderr, /nc-d582-clean\.test\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Il positivo: i nomi neutri non sono codici e non devono accendere il gate.
test('workcodes: neutral fixture and file names pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-neutral-'));
  try {
    const files = [{ rel: 'tests/demo.test.js', data: "const a = 'nc-group-post-';\\nconst b = 'nc-claim-outcome-';\\nconst c = 'nc-sentinel';\nconst d = 'ncdemo-';\\n// provato con seam in fleet-vl-bootstrap-claim-runtime.test.js\\n" }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a family exemption does not hide another family', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-scope-'));
  try {
    const files = [{ rel: 'skills/cellforge/SKILL.md', data: 'An audit of the cell, tracked as D-392.\n' }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /D-392/);
    assert.doesNotMatch(result.stderr, /audit provenance/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a clean binary blob passes through the strings scanner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-bin-clean-'));
  try {
    const payload = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('plain ascii payload inside\0tail'), Buffer.from([0xff])]);
    const files = [{ rel: 'assets/blob.bin', data: payload }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(manifest), 'manifest missing for clean binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workcodes: a denied work token inside a binary blob is caught via strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-wc-bin-deny-'));
  try {
    const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from('note D-392 inside the blob\0'), Buffer.from([0xff])]);
    const files = [{ rel: 'assets/blob.bin', data: payload }];
    const manifest = path.join(dir, 'manifest.json');
    const result = runVerifier({
      staging: syntheticStaging(dir, files), exclude: emptyExclude(dir), manifest, source: syntheticSource(files),
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /D-392/);
    assert.equal(fs.existsSync(manifest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
