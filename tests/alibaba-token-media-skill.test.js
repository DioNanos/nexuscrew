'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'skills', 'alibaba-token-media');
const SCRIPT = path.join(SKILL, 'scripts', 'alibaba_token_media.py');
const PUBLIC_FILES = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/api-contract.md',
  'scripts/alibaba_token_media.py',
];

function python(args, env = {}) {
  return spawnSync('python3', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
  });
}

function parse(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('packaged Alibaba media skill has the exact public portable surface', () => {
  const actual = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else actual.push(relative);
    }
  };
  walk(SKILL);
  assert.deepEqual(actual.sort(), PUBLIC_FILES.slice().sort());

  const source = PUBLIC_FILES.map((file) => fs.readFileSync(path.join(SKILL, file), 'utf8')).join('\n');
  for (const forbidden of [/\/home\/[^/\s]+\//, /\/Users\/[^/\s]+\//, /future-[a-z-]+plugin/i]) {
    assert.doesNotMatch(source, forbidden, `private marker leaked: ${forbidden}`);
  }
  assert.match(source, /~\/Downloads\/alibaba-token-plan\/YYYY-MM-DD/);
  for (const client of ['Claude Code', 'Codex', 'Codex-VL', 'Pi']) assert.match(source, new RegExp(client));
});

test('media CLI compiles and status exposes configuration without the key value', () => {
  const pycache = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-media-pycache-'));
  const compiled = spawnSync('python3', ['-m', 'py_compile', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPYCACHEPREFIX: pycache },
  });
  fs.rmSync(pycache, { recursive: true, force: true });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  const sentinel = 'test-only-key-sentinel-0825';
  const result = python(['status'], { ALIBABA_CODE_API_KEY: sentinel });
  const status = parse(result);
  assert.equal(status.configured, true);
  assert.equal(status.credential_env, 'ALIBABA_CODE_API_KEY');
  assert.equal(status.host, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com');
  assert.deepEqual(status.image_models, ['wan2.7-image', 'wan2.7-image-pro']);
  assert.deepEqual(status.video_models, ['happyhorse-1.1-t2v', 'happyhorse-1.1-i2v']);
  assert.deepEqual(status.supported_clients, ['claude-code', 'codex', 'codex-vl', 'pi']);
  assert.equal(status.local_limits.concurrent_submits, 1);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
});

test('media CLI dry-runs image, text-to-video and image-to-video without a credential', () => {
  const image = parse(python(['image', '--prompt', 'quiet lake', '--dry-run'], { ALIBABA_CODE_API_KEY: '' }));
  assert.equal(image.dry_run, true);
  assert.equal(image.payload.model, 'wan2.7-image');
  assert.equal(image.payload.parameters.n, 1);
  assert.equal(image.payload.parameters.enable_sequential, false);

  const t2v = parse(python(['video-submit', '--prompt', 'paper city', '--dry-run'], { ALIBABA_CODE_API_KEY: '' }));
  assert.equal(t2v.payload.model, 'happyhorse-1.1-t2v');
  assert.equal(t2v.payload.parameters.resolution, '720P');
  assert.equal(t2v.payload.parameters.duration, 3);

  const i2v = parse(python([
    'video-submit', '--model', 'happyhorse-1.1-i2v',
    '--image', 'https://example.com/input.png', '--prompt', 'move forward', '--dry-run',
  ], { ALIBABA_CODE_API_KEY: '' }));
  assert.equal(i2v.payload.model, 'happyhorse-1.1-i2v');
  assert.equal(i2v.payload.input.media[0].url, '[first-frame input omitted]');
  assert.equal(Object.hasOwn(i2v.payload.parameters, 'ratio'), false);
});

test('media CLI rejects high-cost and unsafe inputs before any provider request', () => {
  const pro = python(['image', '--prompt', 'x', '--model', 'wan2.7-image-pro', '--dry-run']);
  assert.equal(pro.status, 2);
  assert.match(pro.stderr, /--confirm-high-cost/);

  const video = python(['video-submit', '--prompt', 'x', '--resolution', '1080P', '--dry-run']);
  assert.equal(video.status, 2);
  assert.match(video.stderr, /--confirm-high-cost/);

  const privateUrl = python([
    'video-submit', '--model', 'happyhorse-1.1-i2v',
    '--image', 'https://127.0.0.1/input.png', '--dry-run',
  ]);
  assert.equal(privateUrl.status, 2);
  assert.match(privateUrl.stderr, /non-public/);

  const noConsent = python(['image', '--prompt', 'x']);
  assert.equal(noConsent.status, 2);
  assert.match(noConsent.stderr, /--confirm-credit-use/);
});

test('media CLI enforces one cross-process submit lock without storing credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-media-home-'));
  const code = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("media", sys.argv[1])',
    'media = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(media)',
    'with media._submit_lock():',
    '  try:',
    '    with media._submit_lock(): pass',
    '  except media.UsageError as exc:',
    '    assert "already in progress" in str(exc)',
    '  else:',
    '    raise AssertionError("second submit lock unexpectedly acquired")',
    'print("LOCK_OK")',
  ].join('\n');
  const result = spawnSync('python3', ['-c', code, SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PYTHONDONTWRITEBYTECODE: '1',
      ALIBABA_CODE_API_KEY: 'test-only-never-persist',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'LOCK_OK');
  const state = fs.readFileSync(path.join(home, '.cache', 'alibaba-token-media', 'submit.lock'), 'utf8');
  assert.equal(state, '');
  fs.rmSync(home, { recursive: true, force: true });
});
