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

function runVerifier({ staging, exclude, manifest, env = process.env }) {
  const invocation = path.join(path.dirname(manifest), 'invocation.argv');
  fs.writeFileSync(invocation, 'negative-control\0');
  return spawnSync(process.execPath, [
    path.join(ROOT, 'publish', 'verify-git-surface.js'), sourceSha(), staging, manifest,
    exclude, path.join(ROOT, 'publish', 'build-git-surface.sh'),
    path.join(ROOT, 'publish', 'public-surface-rules.json'),
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
    const deadStrings = path.join(fakeBin, 'strings');
    fs.writeFileSync(deadStrings, '#!/bin/sh\nexit 77\n', { mode: 0o755 });
    const result = runBuilderWithEnv({ PATH: `${fakeBin}:${process.env.PATH}` , dir });
    assert.notEqual(result.result.status, 0, `${result.result.stdout}\n${result.result.stderr}`);
    assert.equal(fs.existsSync(result.out), false);
    assert.equal(fs.existsSync(result.manifest), false);
    assert.match(result.result.stderr, /scanner binari exited 77|scanner binari non disponibile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runBuilderWithEnv({ PATH, dir }) {
  const out = path.join(dir, 'public');
  const manifest = path.join(dir, 'manifest.json');
  const result = spawnSync(BUILDER, [sourceSha(), out, manifest], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH },
  });
  return { dir, out, manifest, result };
}

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
