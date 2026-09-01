'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(ROOT, 'publish', 'verify-npm-payload.js');

test('npm gate packs and scans the exact source checkout without publishing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-npm-boundary-'));
  try {
    const out = path.join(dir, 'pack');
    const manifest = path.join(dir, 'npm-manifest.json');
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    const result = spawnSync(process.execPath, [VERIFIER, sha, out, manifest], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(data.source.commitSha, sha);
    assert.equal(data.npm.name, '@mmmbuto/nexuscrew');
    assert.equal(data.npm.version, '0.9.16');
    assert.match(data.npm.sha256, /^[0-9a-f]{64}$/);
    assert.ok(data.npm.bytes > 0);
    assert.equal(data.npm.scan.result, 'PASS');
    assert.equal(fs.readdirSync(out).filter((name) => name.endsWith('.tgz')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

