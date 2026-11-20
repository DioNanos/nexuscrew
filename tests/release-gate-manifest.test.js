'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_MANIFEST_BYTES,
  validateClaimPinManifestFile,
} = require('../scripts/release-gate-manifest-check.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHECKER_PATH = path.join(REPO_ROOT, 'scripts', 'release-gate-manifest-check.js');
const GATE_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'release-gate.sh');
const REAL_MANIFEST_PATH = path.join(REPO_ROOT, 'lib', 'fleet', 'vl-claim-pin-manifest.json');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'gate-pin-manifest');

function runCheckerCli(manifestPath) {
  const args = manifestPath === undefined ? [CHECKER_PATH] : [CHECKER_PATH, manifestPath];
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-manifest-'));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('release-gate claim pin manifest validator', () => {
  it('accepts the real repository manifest and prints sha256, v=2 and platform', () => {
    const expectedSha = sha256File(REAL_MANIFEST_PATH);
    const parsedReal = JSON.parse(fs.readFileSync(REAL_MANIFEST_PATH, 'utf8'));
    const res = runCheckerCli(REAL_MANIFEST_PATH);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.equal(
      res.stdout.trim(),
      `ok sha256=${expectedSha} v=2 platform=${parsedReal.platform}`
    );
  });

  it('accepts the valid.json fixture', () => {
    const fixture = path.join(FIXTURES_DIR, 'valid.json');
    const expectedSha = sha256File(fixture);
    const res = runCheckerCli(fixture);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout.trim(),
      `ok sha256=${expectedSha} v=2 platform=linux-x64`
    );
  });

  it('refuses a missing manifest path and missing file with exit 3', () => {
    const noArg = runCheckerCli(undefined);
    assert.equal(noArg.status, 3);
    assert.match(noArg.stderr, /^release-gate-manifest: REFUSED \(io\):/);

    const missing = path.join(FIXTURES_DIR, 'does-not-exist.json');
    const res = runCheckerCli(missing);
    assert.equal(res.status, 3);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^release-gate-manifest: REFUSED \(io\):/);
  });

  it('refuses an empty manifest (0 bytes) with exit 3', () => {
    const dir = makeTmpDir();
    try {
      const emptyPath = path.join(dir, 'empty.json');
      fs.writeFileSync(emptyPath, Buffer.alloc(0));
      const res = runCheckerCli(emptyPath);
      assert.equal(res.status, 3);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^release-gate-manifest: REFUSED \((io|parse)\):/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable manifest (EACCES) with exit 3', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('chmod 000 remains readable under uid 0');
      return;
    }
    const dir = makeTmpDir();
    try {
      const target = path.join(dir, 'unreadable.json');
      fs.copyFileSync(path.join(FIXTURES_DIR, 'valid.json'), target);
      fs.chmodSync(target, 0o000);
      const res = runCheckerCli(target);
      assert.equal(res.status, 3);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^release-gate-manifest: REFUSED \(io\):/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest with reason io when read fails with EIO after valid open/fstat, closes fd, and exits 3 at CLI and gate boundaries', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const dir = makeTmpDir();
    try {
      // 1) In-process bounded reader contract with EIO injected after valid open and fstat.
      const origOpen = fs.openSync;
      const origFstat = fs.fstatSync;
      const origRead = fs.readSync;
      const origClose = fs.closeSync;
      const openedFds = [];
      const closedFds = [];
      let fstatCalls = 0;

      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.push(fd);
        return fd;
      };
      fs.fstatSync = (fd, ...args) => {
        fstatCalls += 1;
        return origFstat.call(fs, fd, ...args);
      };
      fs.readSync = () => {
        const err = new Error('simulated input/output failure');
        err.code = 'EIO';
        throw err;
      };
      fs.closeSync = (fd, ...args) => {
        closedFds.push(fd);
        return origClose.call(fs, fd, ...args);
      };

      let inProcRes;
      try {
        inProcRes = validateClaimPinManifestFile(validFixture);
      } finally {
        fs.openSync = origOpen;
        fs.fstatSync = origFstat;
        fs.readSync = origRead;
        fs.closeSync = origClose;
      }

      assert.equal(openedFds.length, 1);
      assert.equal(fstatCalls, 1);
      assert.deepEqual(closedFds, openedFds);
      assert.equal(inProcRes.ok, false);
      assert.equal(inProcRes.reason, 'io');
      assert.equal(inProcRes.sha256, undefined);
      assert.match(inProcRes.detail, /EIO/);

      // 2) Subprocess CLI boundary with untouched checker via --require preload (not reachable in normal CLI usage).
      const cliStatePath = path.join(dir, 'cli-eio-state.json');
      const gateStatePath = path.join(dir, 'gate-eio-state.json');
      const preloadPath = path.join(dir, 'inject-read-eio.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "'use strict';",
          "const fs = require('node:fs');",
          'const origOpen = fs.openSync;',
          'const origFstat = fs.fstatSync;',
          'const origClose = fs.closeSync;',
          'const opened = [];',
          'const closed = [];',
          'let fstats = 0;',
          'fs.openSync = (...a) => { const fd = origOpen.apply(fs, a); opened.push(fd); return fd; };',
          'fs.fstatSync = (fd, ...a) => { fstats += 1; return origFstat.call(fs, fd, ...a); };',
          "fs.readSync = () => { const e = new Error('disk read failure'); e.code = 'EIO'; throw e; };",
          'fs.closeSync = (fd, ...a) => { closed.push(fd); return origClose.call(fs, fd, ...a); };',
          "process.on('exit', () => {",
          '  if (process.env.TEST_EIO_STATE_FILE) {',
          "    fs.writeFileSync(process.env.TEST_EIO_STATE_FILE, JSON.stringify({ opened, fstats, closed }));",
          '  }',
          '});',
        ].join('\n')
      );

      const cliRes = spawnSync(process.execPath, ['--require', preloadPath, CHECKER_PATH, validFixture], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TEST_EIO_STATE_FILE: cliStatePath },
      });
      assert.equal(cliRes.status, 3, cliRes.stderr);
      assert.equal(cliRes.stdout, '');
      assert.match(cliRes.stderr, /^release-gate-manifest: REFUSED \(io\):/);
      assert.match(cliRes.stderr, /EIO/);
      const cliState = JSON.parse(fs.readFileSync(cliStatePath, 'utf8'));
      assert.equal(cliState.opened.length, 1);
      assert.equal(cliState.fstats, 1);
      assert.deepEqual(cliState.closed, cliState.opened);

      // 3) release-gate.sh check_pin_manifest boundary inherits exit 3 and pin-manifest tag on validator EIO refusal.
      const fakeNode = path.join(dir, 'node-eio-wrapper.sh');
      fs.writeFileSync(
        fakeNode,
        [
          '#!/bin/sh',
          `exec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(preloadPath)} "$@"`,
        ].join('\n'),
        { mode: 0o755 }
      );
      const gateRes = runGatePinPreflight(validFixture, '', {
        TEST_GATE_NODE: fakeNode,
        TEST_EIO_STATE_FILE: gateStatePath,
      });
      assert.equal(gateRes.status, 3, gateRes.stderr);
      assert.equal(gateRes.stdout, '');
      assert.match(gateRes.stderr, /^release-gate: REFUSED \(pin-manifest\):/);
      assert.match(gateRes.stderr, /REFUSED \(io\):/);
      const gateState = JSON.parse(fs.readFileSync(gateStatePath, 'utf8'));
      assert.equal(gateState.opened.length, 1);
      assert.deepEqual(gateState.closed, gateState.opened);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest with reason io when a subsequent read after valid bytes fails with EIO, closes fd, and exits 3 at CLI and gate boundaries', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const validBytes = fs.readFileSync(validFixture);
    const dir = makeTmpDir();
    try {
      // 1) In-process: first read returns valid manifest bytes, second read throws EIO instead of returning 0 (EOF).
      const origOpen = fs.openSync;
      const origFstat = fs.fstatSync;
      const origRead = fs.readSync;
      const origClose = fs.closeSync;
      const openedFds = [];
      const closedFds = [];
      let readCalls = 0;

      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.push(fd);
        return fd;
      };
      fs.fstatSync = (fd, ...args) => origFstat.call(fs, fd, ...args);
      fs.readSync = (fd, buffer, offset, length) => {
        readCalls += 1;
        if (readCalls === 1) {
          const toCopy = Math.min(validBytes.length, length);
          validBytes.copy(buffer, offset, 0, toCopy);
          return toCopy;
        }
        const err = new Error('simulated mid-stream input/output failure');
        err.code = 'EIO';
        throw err;
      };
      fs.closeSync = (fd, ...args) => {
        closedFds.push(fd);
        return origClose.call(fs, fd, ...args);
      };

      let inProcRes;
      try {
        inProcRes = validateClaimPinManifestFile(validFixture);
      } finally {
        fs.openSync = origOpen;
        fs.fstatSync = origFstat;
        fs.readSync = origRead;
        fs.closeSync = origClose;
      }

      assert.equal(readCalls, 2);
      assert.equal(openedFds.length, 1);
      assert.deepEqual(closedFds, openedFds);
      assert.equal(inProcRes.ok, false);
      assert.equal(inProcRes.reason, 'io');
      assert.equal(inProcRes.sha256, undefined);
      assert.equal(inProcRes.parsed, undefined);
      assert.match(inProcRes.detail, /EIO/);

      // 2) Subprocess CLI boundary with untouched checker via --require preload delivering valid bytes then EIO.
      const cliStatePath = path.join(dir, 'cli-partial-eio.json');
      const gateStatePath = path.join(dir, 'gate-partial-eio.json');
      const preloadPath = path.join(dir, 'inject-partial-eio.cjs');
      fs.writeFileSync(
        preloadPath,
        [
          "'use strict';",
          "const fs = require('node:fs');",
          `const payload = fs.readFileSync(${JSON.stringify(validFixture)});`,
          'const origOpen = fs.openSync;',
          'const origClose = fs.closeSync;',
          'const opened = [];',
          'const closed = [];',
          'let reads = 0;',
          'fs.openSync = (...a) => { const fd = origOpen.apply(fs, a); opened.push(fd); return fd; };',
          'fs.readSync = (fd, buf, offset, len) => {',
          '  reads += 1;',
          '  if (reads === 1) { const n = Math.min(payload.length, len); payload.copy(buf, offset, 0, n); return n; }',
          "  const e = new Error('second read failure'); e.code = 'EIO'; throw e;",
          '};',
          'fs.closeSync = (fd, ...a) => { closed.push(fd); return origClose.call(fs, fd, ...a); };',
          "process.on('exit', () => {",
          '  if (process.env.TEST_EIO_STATE_FILE) {',
          '    fs.writeFileSync(process.env.TEST_EIO_STATE_FILE, JSON.stringify({ opened, reads, closed }));',
          '  }',
          '});',
        ].join('\n')
      );

      const cliRes = spawnSync(process.execPath, ['--require', preloadPath, CHECKER_PATH, validFixture], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TEST_EIO_STATE_FILE: cliStatePath },
      });
      assert.equal(cliRes.status, 3, `CLI must refuse partial EIO, got stdout=${cliRes.stdout}`);
      assert.equal(cliRes.stdout, '');
      assert.match(cliRes.stderr, /^release-gate-manifest: REFUSED \(io\):/);
      assert.match(cliRes.stderr, /EIO/);
      const cliState = JSON.parse(fs.readFileSync(cliStatePath, 'utf8'));
      assert.equal(cliState.reads, 2);
      assert.equal(cliState.opened.length, 1);
      assert.deepEqual(cliState.closed, cliState.opened);

      // 3) release-gate.sh check_pin_manifest boundary must also refuse exit 3 without emitting pin metadata.
      const fakeNode = path.join(dir, 'node-partial-eio.sh');
      fs.writeFileSync(
        fakeNode,
        [
          '#!/bin/sh',
          `exec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(preloadPath)} "$@"`,
        ].join('\n'),
        { mode: 0o755 }
      );
      const gateRes = runGatePinPreflight(
        validFixture,
        'printf "LEAKED=%s:%s:%s\\n" "${PIN_MANIFEST_SHA:-}" "${PIN_MANIFEST_V:-}" "${PIN_MANIFEST_PLATFORM:-}"',
        { TEST_GATE_NODE: fakeNode, TEST_EIO_STATE_FILE: gateStatePath }
      );
      assert.equal(gateRes.status, 3, `gate must refuse partial EIO, got stdout=${gateRes.stdout}`);
      assert.equal(gateRes.stdout, '');
      assert.match(gateRes.stderr, /^release-gate: REFUSED \(pin-manifest\):/);
      assert.match(gateRes.stderr, /REFUSED \(io\):/);
      const gateState = JSON.parse(fs.readFileSync(gateStatePath, 'utf8'));
      assert.equal(gateState.reads, 2);
      assert.equal(gateState.opened.length, 1);
      assert.deepEqual(gateState.closed, gateState.opened);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses non-regular files (symlink and directory) and oversize manifests (> 4096 bytes)', () => {
    const dir = makeTmpDir();
    try {
      const linkPath = path.join(dir, 'symlink.json');
      fs.symlinkSync(path.join(FIXTURES_DIR, 'valid.json'), linkPath);
      const linkRes = runCheckerCli(linkPath);
      assert.equal(linkRes.status, 3);
      assert.match(linkRes.stderr, /^release-gate-manifest: REFUSED \(io\):/);

      const dirRes = runCheckerCli(dir);
      assert.equal(dirRes.status, 3);
      assert.match(dirRes.stderr, /^release-gate-manifest: REFUSED \(io\):/);

      const bigPath = path.join(dir, 'oversize.json');
      const pad = 'x'.repeat(MAX_MANIFEST_BYTES);
      fs.writeFileSync(
        bigPath,
        JSON.stringify({
          v: 2,
          platform: 'linux-x64',
          flock: { source: pad, version: '2.39.3', sha256: '1'.repeat(64) },
          helper: { sha256: '2'.repeat(64) },
        })
      );
      assert.ok(fs.statSync(bigPath).size > MAX_MANIFEST_BYTES);
      const bigRes = runCheckerCli(bigPath);
      assert.equal(bigRes.status, 3);
      assert.match(bigRes.stderr, /^release-gate-manifest: REFUSED \(io\):/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // These three fixtures carry raw token matches for "v": 2 / "flock": / "helper":
  // without a forbidden "node": key, so a regex-only check wrongly accepts them.
  it('refuses truncated.json, signatures-text.txt, and v-fraction.json with exit 3', () => {
    for (const [name, expectedReason] of [
      ['truncated.json', 'parse'],
      ['signatures-text.txt', 'parse'],
      ['v-fraction.json', 'schema'],
    ]) {
      const res = runCheckerCli(path.join(FIXTURES_DIR, name));
      assert.equal(res.status, 3, `${name} should fail`);
      assert.equal(res.stdout, '', `${name} must not emit ok output`);
      assert.match(
        res.stderr,
        new RegExp(`^release-gate-manifest: REFUSED \\(${expectedReason}\\):`),
        `${name} stderr mismatch: ${res.stderr}`
      );
    }
  });

  it('refuses v-string, v!=2, node-key, extra keys, bad hashes, and wrong field types', () => {
    for (const name of [
      'v-string.json',
      'node-key.json',
      'extra.json',
      'short-hash.json',
      'wrong-type.json',
    ]) {
      const res = runCheckerCli(path.join(FIXTURES_DIR, name));
      assert.equal(res.status, 3, `${name} should fail`);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^release-gate-manifest: REFUSED \(schema\):/, `${name}: ${res.stderr}`);
    }

    const dir = makeTmpDir();
    try {
      const cases = [
        { name: 'v-one.json', data: { v: 1, platform: 'linux-x64', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: '1'.repeat(64) }, helper: { sha256: '2'.repeat(64) } } },
        { name: 'flock-extra.json', data: { v: 2, platform: 'linux-x64', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: '1'.repeat(64), extra: 1 }, helper: { sha256: '2'.repeat(64) } } },
        { name: 'helper-extra.json', data: { v: 2, platform: 'linux-x64', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: '1'.repeat(64) }, helper: { sha256: '2'.repeat(64), extra: 1 } } },
        { name: 'uppercase-hash.json', data: { v: 2, platform: 'linux-x64', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: 'A'.repeat(64) }, helper: { sha256: '2'.repeat(64) } } },
        { name: 'non-hex-helper.json', data: { v: 2, platform: 'linux-x64', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: '1'.repeat(64) }, helper: { sha256: 'z'.repeat(64) } } },
        { name: 'empty-source.json', data: { v: 2, platform: 'linux-x64', flock: { source: '', version: '2.39.3', sha256: '1'.repeat(64) }, helper: { sha256: '2'.repeat(64) } } },
        { name: 'empty-platform.json', data: { v: 2, platform: '', flock: { source: '/usr/bin/flock', version: '2.39.3', sha256: '1'.repeat(64) }, helper: { sha256: '2'.repeat(64) } } },
        { name: 'array-root.json', data: [] },
      ];
      for (const c of cases) {
        const p = path.join(dir, c.name);
        fs.writeFileSync(p, JSON.stringify(c.data));
        const res = validateClaimPinManifestFile(p);
        assert.equal(res.ok, false, `${c.name} should be rejected`);
        assert.equal(res.reason, 'schema', `${c.name} reason should be schema`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses only node:fs and node:crypto, declares 4096-byte cap, and performs zero product imports or hash whitelist checks', () => {
    const src = fs.readFileSync(CHECKER_PATH, 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(requires.sort(), ['node:crypto', 'node:fs']);
    assert.equal(MAX_MANIFEST_BYTES, 4096);
    assert.match(src, /const MAX_MANIFEST_BYTES = 4096;/);
    // The validator measures the manifest file digest only; it never embeds or
    // compares against approved product/flock/helper byte hashes.
    assert.doesNotMatch(src, /[0-9a-f]{64}/i);
  });

  it('refuses duplicate JSON keys at root, flock, and helper levels (including unicode escapes) with exit 3', () => {
    const dupRootRes = runCheckerCli(path.join(FIXTURES_DIR, 'duplicate-root-key.json'));
    assert.equal(dupRootRes.status, 3);
    assert.equal(dupRootRes.stdout, '');
    assert.match(dupRootRes.stderr, /^release-gate-manifest: REFUSED \((parse|schema)\):/);

    const dir = makeTmpDir();
    try {
      const h1 = '1'.repeat(64);
      const h2 = '2'.repeat(64);
      const rawCases = [
        {
          name: 'dup-root-v.json',
          raw: `{"v":1,"v":2,"platform":"linux-x64","flock":{"source":"/usr/bin/flock","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}"}}`,
        },
        {
          name: 'dup-root-unicode-escape.json',
          raw: `{"v":2,"\\u0076":2,"platform":"linux-x64","flock":{"source":"/usr/bin/flock","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}"}}`,
        },
        {
          name: 'dup-flock-source.json',
          raw: `{"v":2,"platform":"linux-x64","flock":{"source":"/usr/bin/flock","source":"/opt/other","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}"}}`,
        },
        {
          name: 'dup-helper-sha256.json',
          raw: `{"v":2,"platform":"linux-x64","flock":{"source":"/usr/bin/flock","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}","sha256":"${h1}"}}`,
        },
      ];
      for (const c of rawCases) {
        const p = path.join(dir, c.name);
        fs.writeFileSync(p, c.raw, 'utf8');
        const res = runCheckerCli(p);
        assert.equal(res.status, 3, `${c.name} should fail with exit 3`);
        assert.equal(res.stdout, '', `${c.name} must emit empty stdout`);
        assert.match(res.stderr, /^release-gate-manifest: REFUSED \((parse|schema)\):/, `${c.name}: ${res.stderr}`);
      }

      // String literal containing duplicate-looking key tokens must not trigger false rejection.
      const literalPath = path.join(dir, 'string-literal-tokens.json');
      fs.writeFileSync(
        literalPath,
        JSON.stringify({
          v: 2,
          platform: 'linux-x64',
          flock: { source: '/bin/flock{"k":1,"k":2}', version: '2.39.3', sha256: h1 },
          helper: { sha256: h2 },
        }),
        'utf8'
      );
      const literalRes = runCheckerCli(literalPath);
      assert.equal(literalRes.status, 0, literalRes.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses invalid UTF-8 byte sequences strictly before parsing with exit 3', () => {
    const dir = makeTmpDir();
    try {
      const h1 = '1'.repeat(64);
      const h2 = '2'.repeat(64);
      const prefixPlatform = Buffer.from('{"v":2,"platform":"linux-', 'utf8');
      const suffixPlatform = Buffer.from(`","flock":{"source":"/usr/bin/flock","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}"}}`, 'utf8');
      const prefixSource = Buffer.from('{"v":2,"platform":"linux-x64","flock":{"source":"/usr/bin/', 'utf8');
      const suffixSource = Buffer.from(`","version":"2.39.3","sha256":"${h1}"},"helper":{"sha256":"${h2}"}}`, 'utf8');

      const badUtf8Cases = [
        {
          name: 'bad-utf8-c3-28.json',
          buf: Buffer.concat([prefixPlatform, Buffer.from([0xc3, 0x28]), suffixPlatform]),
        },
        {
          name: 'bad-utf8-ff.json',
          buf: Buffer.concat([prefixSource, Buffer.from([0xff]), suffixSource]),
        },
        {
          name: 'utf16le-bom.json',
          buf: Buffer.concat([Buffer.from([0xff, 0xfe]), fs.readFileSync(path.join(FIXTURES_DIR, 'valid.json'))]),
        },
      ];

      for (const c of badUtf8Cases) {
        const p = path.join(dir, c.name);
        fs.writeFileSync(p, c.buf);
        const res = runCheckerCli(p);
        assert.equal(res.status, 3, `${c.name} must be refused with exit 3`);
        assert.equal(res.stdout, '', `${c.name} must emit empty stdout`);
        assert.match(res.stderr, /^release-gate-manifest: REFUSED \(parse\):/, `${c.name}: ${res.stderr}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses bom-utf8.json and trailing-bytes.json fixtures with reason parse and exit 3', () => {
    for (const name of ['bom-utf8.json', 'trailing-bytes.json']) {
      const res = runCheckerCli(path.join(FIXTURES_DIR, name));
      assert.equal(res.status, 3, `${name} must be refused`);
      assert.equal(res.stdout, '', `${name} must not emit stdout`);
      assert.match(res.stderr, /^release-gate-manifest: REFUSED \(parse\):/, `${name}: ${res.stderr}`);
    }
  });
});

// Runs the pin-manifest validation block extracted directly from scripts/release-gate.sh
// without launching the full suite or requiring local .gate-bin executables.
function runGatePinPreflight(manifestPath, postScript = '', envOverrides = {}) {
  const gateSrc = fs.readFileSync(GATE_SCRIPT_PATH, 'utf8');
  const startMarker = 'PIN_MANIFEST=lib/fleet/vl-claim-pin-manifest.json';
  const endMarker = '# Measured as evidence only:';
  const startIdx = gateSrc.indexOf(startMarker);
  const endIdx = gateSrc.indexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx > startIdx, 'pin manifest block markers missing in release-gate.sh');
  const block = gateSrc
    .slice(startIdx, endIdx)
    .replace(startMarker, 'PIN_MANIFEST="$TEST_PIN_MANIFEST"');
  const script = [
    'set -uo pipefail',
    'IFS=$\'\\n\\t\'',
    'die() { printf \'release-gate: REFUSED (%s): %s\\n\' "$1" "$2" >&2; exit "$3"; }',
    'sha_of() { sha256sum "$1" | awk \'{print $1}\'; }',
    'GATE_NODE="$TEST_GATE_NODE"',
    block,
    postScript,
  ].join('\n');
  return spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      HOME: REPO_ROOT,
      TMPDIR: os.tmpdir(),
      TEST_GATE_NODE: process.execPath,
      TEST_PIN_MANIFEST: manifestPath,
      ...envOverrides,
    },
  });
}

describe('release-gate.sh pin manifest wiring and digest freeze', () => {
  it('gate preflight rejects truncated.json, signatures-text.txt, v-fraction.json, node-key.json, and 0-byte manifest with exit 3', () => {
    for (const name of ['truncated.json', 'signatures-text.txt', 'v-fraction.json', 'node-key.json']) {
      const res = runGatePinPreflight(path.join(FIXTURES_DIR, name));
      assert.equal(res.status, 3, `release-gate.sh preflight must reject ${name}`);
      assert.match(res.stderr, /^release-gate: REFUSED \(pin-manifest\):/);
    }
    const dir = makeTmpDir();
    try {
      const emptyPath = path.join(dir, 'empty.json');
      fs.writeFileSync(emptyPath, Buffer.alloc(0));
      const res = runGatePinPreflight(emptyPath);
      assert.equal(res.status, 3, 'release-gate.sh preflight must reject 0-byte empty manifest');
      assert.match(res.stderr, /^release-gate: REFUSED \(pin-manifest\):/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate preflight captures digest/v/platform and freeze re-check refuses mid-run edits', () => {
    const dir = makeTmpDir();
    try {
      const copy = path.join(dir, 'pin.json');
      fs.copyFileSync(path.join(FIXTURES_DIR, 'valid.json'), copy);
      const expectedSha = sha256File(copy);

      const okRes = runGatePinPreflight(
        copy,
        [
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "before-suite"',
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "after-suite"',
          'printf "sha=%s v=%s platform=%s\\n" "$PIN_MANIFEST_SHA" "$PIN_MANIFEST_V" "$PIN_MANIFEST_PLATFORM"',
        ].join('\n')
      );
      assert.equal(okRes.status, 0, okRes.stderr);
      assert.equal(okRes.stdout.trim(), `sha=${expectedSha} v=2 platform=linux-x64`);

      const modifiedRes = runGatePinPreflight(
        copy,
        [
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "before-suite"',
          'printf " " >> "$PIN_MANIFEST"',
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "after-suite"',
        ].join('\n')
      );
      assert.equal(modifiedRes.status, 3);
      assert.match(modifiedRes.stderr, /claim pin manifest changed during run \(after-suite\)/);

      const beforeSuiteMod = runGatePinPreflight(
        copy,
        [
          'printf " " >> "$PIN_MANIFEST"',
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "before-suite"',
        ].join('\n')
      );
      assert.equal(beforeSuiteMod.status, 3);
      assert.match(beforeSuiteMod.stderr, /claim pin manifest changed during run \(before-suite\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders preflight check, manifest recording, before-suite re-check, suite run, and after-suite re-check', () => {
    const gateSrc = fs.readFileSync(GATE_SCRIPT_PATH, 'utf8');
    const preflightPos = gateSrc.indexOf('check_pin_manifest "$PIN_MANIFEST"');
    const manifestPos = gateSrc.indexOf("printf 'pin manifest: %s\\n  sha256: %s\\n  schema: v%s\\n  platform: %s\\n'");
    const beforePos = gateSrc.indexOf('verify_pin_manifest_unchanged "$PIN_MANIFEST" "before-suite"');
    const suitePos = gateSrc.indexOf('systemd-run --user --scope -q \\');
    const afterPos = gateSrc.indexOf('verify_pin_manifest_unchanged "$PIN_MANIFEST" "after-suite"');
    assert.ok(preflightPos > 0);
    assert.ok(manifestPos > preflightPos);
    assert.ok(beforePos > manifestPos);
    assert.ok(suitePos > beforePos);
    assert.ok(afterPos > suitePos);
  });

  it('refuses raw-byte spurious validator outputs (LF/NUL stderr, NUL stdout, extra/unterminated lines, non-hex/uppercase/version/spaced) while canonical from same generator passes', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const canonicalHex = sha256File(validFixture);
    const dir = makeTmpDir();
    try {
      const fakeNode = path.join(dir, 'fake-validator-node.sh');
      fs.writeFileSync(
        fakeNode,
        [
          '#!/bin/sh',
          'cat "$TEST_FAKE_STDOUT_FILE"',
          'cat "$TEST_FAKE_STDERR_FILE" >&2',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 }
      );

      const emitViaFakeValidator = (caseName, stdoutBuf, stderrBuf, postScript = '') => {
        const stdoutFile = path.join(dir, `${caseName}.stdout.bin`);
        const stderrFile = path.join(dir, `${caseName}.stderr.bin`);
        fs.writeFileSync(stdoutFile, stdoutBuf);
        fs.writeFileSync(stderrFile, stderrBuf);
        return runGatePinPreflight(validFixture, postScript, {
          TEST_GATE_NODE: fakeNode,
          TEST_FAKE_STDOUT_FILE: stdoutFile,
          TEST_FAKE_STDERR_FILE: stderrFile,
        });
      };

      const validHex = 'a'.repeat(64);
      const canonicalLine = Buffer.from(`ok sha256=${canonicalHex} v=2 platform=linux-x64\n`, 'utf8');
      const cases = [
        { name: 'stderr-lf-only', stdout: canonicalLine, stderr: Buffer.from('\n', 'utf8') },
        { name: 'stderr-nul-only', stdout: canonicalLine, stderr: Buffer.from([0x00]) },
        {
          name: 'stdout-nul-mid',
          stdout: Buffer.concat([
            Buffer.from(`ok sha256=${validHex} v=2 platform=linux`, 'utf8'),
            Buffer.from([0x00]),
            Buffer.from('x64\n', 'utf8'),
          ]),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'stdout-nul-tail',
          stdout: Buffer.concat([
            Buffer.from(`ok sha256=${validHex} v=2 platform=linux-x64`, 'utf8'),
            Buffer.from([0x00, 0x0a]),
          ]),
          stderr: Buffer.alloc(0),
        },
        { name: 'stdout-empty', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        {
          name: 'extra-line',
          stdout: Buffer.from(`ok sha256=${validHex} v=2 platform=linux-x64\nok sha256=${validHex} v=2 platform=linux-x64\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'trailing-blank-line',
          stdout: Buffer.from(`ok sha256=${validHex} v=2 platform=linux-x64\n\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'trailing-text-no-nl',
          stdout: Buffer.from(`ok sha256=${validHex} v=2 platform=linux-x64\nextra=1`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'unterminated-line',
          stdout: Buffer.from(`ok sha256=${validHex} v=2 platform=linux-x64`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'non-hex-digest',
          stdout: Buffer.from(`ok sha256=${'g'.repeat(64)} v=2 platform=linux-x64\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'uppercase-hex-digest',
          stdout: Buffer.from(`ok sha256=${'A'.repeat(64)} v=2 platform=linux-x64\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'wrong-version',
          stdout: Buffer.from(`ok sha256=${validHex} v=3 platform=linux-x64\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'spaced-platform',
          stdout: Buffer.from(`ok sha256=${validHex} v=2 platform=linux x64\n`, 'utf8'),
          stderr: Buffer.alloc(0),
        },
        {
          name: 'mixed-stderr-warning',
          stdout: canonicalLine,
          stderr: Buffer.from('warn: extraneous notice\n', 'utf8'),
        },
      ];

      for (const c of cases) {
        const res = emitViaFakeValidator(c.name, c.stdout, c.stderr);
        assert.equal(res.status, 3, `${c.name} must be refused with exit 3`);
        assert.equal(res.stdout, '', `${c.name} must not emit stdout`);
        assert.match(res.stderr, /^release-gate: REFUSED \(pin-manifest\):/, `${c.name}: ${res.stderr}`);
      }

      // Canonical output emitted by the SAME byte-exact generator passes with empty stderr.
      const fakeCanonicalRes = emitViaFakeValidator(
        'canonical-positive',
        canonicalLine,
        Buffer.alloc(0),
        [
          'verify_pin_manifest_unchanged "$PIN_MANIFEST" "before-suite"',
          'printf "%s %s %s\\n" "$PIN_MANIFEST_SHA" "$PIN_MANIFEST_V" "$PIN_MANIFEST_PLATFORM"',
        ].join('\n')
      );
      assert.equal(fakeCanonicalRes.status, 0, fakeCanonicalRes.stderr);
      assert.equal(fakeCanonicalRes.stderr, '');
      assert.equal(fakeCanonicalRes.stdout.trim(), `${canonicalHex} 2 linux-x64`);

      // Real checker canonical output also passes cleanly end-to-end.
      const canonicalRes = runGatePinPreflight(
        validFixture,
        'printf "%s %s %s\\n" "$PIN_MANIFEST_SHA" "$PIN_MANIFEST_V" "$PIN_MANIFEST_PLATFORM"'
      );
      assert.equal(canonicalRes.status, 0, canonicalRes.stderr);
      assert.equal(canonicalRes.stderr, '');
      assert.equal(canonicalRes.stdout.trim(), `${canonicalHex} 2 linux-x64`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes control/non-ASCII bytes to ? and caps diagnostic previews to 200 bytes across all rejection branches', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const canonicalHex = sha256File(validFixture);
    const dir = makeTmpDir();
    try {
      const fakeNode = path.join(dir, 'fake-diag-node.sh');
      fs.writeFileSync(
        fakeNode,
        [
          '#!/bin/sh',
          'cat "$TEST_FAKE_STDOUT_FILE"',
          'cat "$TEST_FAKE_STDERR_FILE" >&2',
          'exit "${TEST_FAKE_EXIT_CODE:-0}"',
        ].join('\n'),
        { mode: 0o755 }
      );

      const postProbe = 'printf "LEAKED=%s:%s:%s\\n" "${PIN_MANIFEST_SHA:-}" "${PIN_MANIFEST_V:-}" "${PIN_MANIFEST_PLATFORM:-}"';
      const emitDiagCase = (caseName, stdoutBuf, stderrBuf, exitCode = 0, postScript = postProbe) => {
        const stdoutFile = path.join(dir, `${caseName}.stdout.bin`);
        const stderrFile = path.join(dir, `${caseName}.stderr.bin`);
        fs.writeFileSync(stdoutFile, stdoutBuf);
        fs.writeFileSync(stderrFile, stderrBuf);
        return runGatePinPreflight(validFixture, postScript, {
          TEST_GATE_NODE: fakeNode,
          TEST_FAKE_STDOUT_FILE: stdoutFile,
          TEST_FAKE_STDERR_FILE: stderrFile,
          TEST_FAKE_EXIT_CODE: String(exitCode),
        });
      };

      const assertSafeDiagStderr = (stderrText, label) => {
        const buf = Buffer.from(stderrText, 'utf8');
        assert.ok(buf.length > 0, `${label}: empty stderr`);
        assert.equal(buf[buf.length - 1], 0x0a, `${label}: stderr must end with single LF`);
        const body = buf.subarray(0, buf.length - 1);
        for (let i = 0; i < body.length; i += 1) {
          const byte = body[i];
          assert.ok(
            byte >= 0x20 && byte <= 0x7e,
            `${label}: unsafe byte 0x${byte.toString(16)} at offset ${i}`
          );
        }
        assert.match(stderrText, /^release-gate: REFUSED \(pin-manifest\): /);
        const marker = stderrText.includes(`${validFixture}): `)
          ? `${validFixture}): `
          : `${validFixture}: `;
        const idx = stderrText.indexOf(marker);
        assert.ok(idx !== -1, `${label}: missing manifest prefix in ${stderrText}`);
        const preview = stderrText.slice(idx + marker.length, -1);
        assert.ok(
          Buffer.byteLength(preview, 'utf8') <= 200,
          `${label}: preview length ${Buffer.byteLength(preview, 'utf8')} exceeds 200 bytes`
        );
        return preview;
      };

      const canonicalLine = Buffer.from(`ok sha256=${canonicalHex} v=2 platform=linux-x64\n`, 'utf8');

      // 1) Canonical stdout + stderr carrying ESC[2J, CR, BS, DEL, high-bit byte.
      const stderrCtrl = Buffer.from('\x1b[2J\rSUCCESS\x08!\x7f\xff', 'latin1');
      const res1 = emitDiagCase('stderr-controls', canonicalLine, stderrCtrl, 0);
      assert.equal(res1.status, 3);
      assert.equal(res1.stdout, '');
      const prev1 = assertSafeDiagStderr(res1.stderr, 'stderr-controls');
      assert.equal(prev1, '?[2J?SUCCESS?!??');

      // 2) Non-zero rc with control bytes on stderr (and fallback on stdout).
      const rcCtrlErr = Buffer.from('\x1b[31mFAIL\x1b[0m\r\x08\x00\x7f\xfe\n', 'latin1');
      const res2a = emitDiagCase('rc-nonzero-stderr-controls', Buffer.alloc(0), rcCtrlErr, 2);
      assert.equal(res2a.status, 3);
      assert.equal(res2a.stdout, '');
      const prev2a = assertSafeDiagStderr(res2a.stderr, 'rc-nonzero-stderr-controls');
      assert.equal(prev2a, '?[31mFAIL?[0m??????');

      const res2b = emitDiagCase('rc-nonzero-stdout-controls', rcCtrlErr, Buffer.alloc(0), 2);
      assert.equal(res2b.status, 3);
      assert.equal(res2b.stdout, '');
      const prev2b = assertSafeDiagStderr(res2b.stderr, 'rc-nonzero-stdout-controls');
      assert.equal(prev2b, '?[31mFAIL?[0m??????');

      // 3) Rejected single-line stdout (rc 0, empty stderr) containing ESC/CR/BS/BEL/DEL/high bytes.
      const badStdout = Buffer.concat([
        Buffer.from(`ok sha256=${'A'.repeat(64)} v=2 platform=linux`, 'utf8'),
        Buffer.from('\x1b[2J\r\x08\x07\x7f\x80', 'latin1'),
        Buffer.from('\n', 'utf8'),
      ]);
      const res3 = emitDiagCase('stdout-rejected-controls', badStdout, Buffer.alloc(0), 0);
      assert.equal(res3.status, 3);
      assert.equal(res3.stdout, '');
      const prev3 = assertSafeDiagStderr(res3.stderr, 'stdout-rejected-controls');
      assert.ok(prev3.includes('linux?[2J??????'));

      // 4) Over-limit (> 200 bytes) outputs on all three branches truncate cleanly within 200 bytes.
      const longCtrl = Buffer.concat([
        Buffer.from('\x1b[2J', 'latin1'),
        Buffer.from('X'.repeat(500), 'utf8'),
        Buffer.from('\n', 'utf8'),
      ]);
      const longStdout = Buffer.from(`ok sha256=${'A'.repeat(64)} v=2 platform=${'P'.repeat(250)}\n`, 'utf8');
      for (const [label, outB, errB, code] of [
        ['long-rc', Buffer.alloc(0), longCtrl, 2],
        ['long-stderr', canonicalLine, longCtrl, 0],
        ['long-stdout', longStdout, Buffer.alloc(0), 0],
      ]) {
        const res = emitDiagCase(label, outB, errB, code);
        assert.equal(res.status, 3, label);
        assert.equal(res.stdout, '', label);
        const prev = assertSafeDiagStderr(res.stderr, label);
        assert.equal(Buffer.byteLength(prev, 'utf8'), 200, `${label}: truncated preview must equal 200 bytes`);
        assert.ok(prev.endsWith('...[truncated]'), `${label}: missing truncation suffix in ${prev}`);
      }

      // Canonical positive via the exact same binary generator remains intact.
      const okRes = emitDiagCase(
        'diag-canonical-positive',
        canonicalLine,
        Buffer.alloc(0),
        0,
        'printf "%s %s %s\\n" "$PIN_MANIFEST_SHA" "$PIN_MANIFEST_V" "$PIN_MANIFEST_PLATFORM"'
      );
      assert.equal(okRes.status, 0, okRes.stderr);
      assert.equal(okRes.stderr, '');
      assert.equal(okRes.stdout.trim(), `${canonicalHex} 2 linux-x64`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate preflight rejects duplicate-root-key.json, bom-utf8.json, and trailing-bytes.json and leaves no tmp files on refusal or success', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const canonicalHex = sha256File(validFixture);
    const dir = makeTmpDir();
    try {
      const runTmpDir = path.join(dir, 'tmp');
      fs.mkdirSync(runTmpDir);

      for (const name of ['duplicate-root-key.json', 'bom-utf8.json', 'trailing-bytes.json', 'truncated.json']) {
        const res = runGatePinPreflight(path.join(FIXTURES_DIR, name), '', { TMPDIR: runTmpDir });
        assert.equal(res.status, 3, `${name} must fail at gate preflight`);
        assert.equal(res.stdout, '');
        assert.match(res.stderr, /^release-gate: REFUSED \(pin-manifest\):/);
        assert.deepEqual(fs.readdirSync(runTmpDir), [], `temporary files remained after refusing ${name}`);
      }

      const fakeNode = path.join(dir, 'fake-spurious-node.sh');
      fs.writeFileSync(
        fakeNode,
        [
          '#!/bin/sh',
          'cat "$TEST_FAKE_STDOUT_FILE"',
          'cat "$TEST_FAKE_STDERR_FILE" >&2',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 }
      );
      const outBin = path.join(dir, 'spurious.out');
      const errBin = path.join(dir, 'spurious.err');
      fs.writeFileSync(outBin, `ok sha256=${canonicalHex} v=2 platform=linux-x64\n`, 'utf8');
      fs.writeFileSync(errBin, 'spurious\n', 'utf8');
      const errChannelRefusal = runGatePinPreflight(validFixture, '', {
        TMPDIR: runTmpDir,
        TEST_GATE_NODE: fakeNode,
        TEST_FAKE_STDOUT_FILE: outBin,
        TEST_FAKE_STDERR_FILE: errBin,
      });
      assert.equal(errChannelRefusal.status, 3);
      assert.deepEqual(fs.readdirSync(runTmpDir), [], 'temporary files remained after non-empty stderr refusal');

      const badStdoutBin = path.join(dir, 'bad-stdout.out');
      const emptyErrBin = path.join(dir, 'empty.err');
      fs.writeFileSync(badStdoutBin, 'unexpected output\n', 'utf8');
      fs.writeFileSync(emptyErrBin, '', 'utf8');
      const badStdoutRefusal = runGatePinPreflight(validFixture, '', {
        TMPDIR: runTmpDir,
        TEST_GATE_NODE: fakeNode,
        TEST_FAKE_STDOUT_FILE: badStdoutBin,
        TEST_FAKE_STDERR_FILE: emptyErrBin,
      });
      assert.equal(badStdoutRefusal.status, 3);
      assert.deepEqual(fs.readdirSync(runTmpDir), [], 'temporary files remained after bad stdout refusal');

      const okRes = runGatePinPreflight(validFixture, 'printf "%s\\n" "$PIN_MANIFEST_SHA"', { TMPDIR: runTmpDir });
      assert.equal(okRes.status, 0, okRes.stderr);
      assert.equal(okRes.stdout.trim(), canonicalHex);
      assert.deepEqual(fs.readdirSync(runTmpDir), [], 'temporary files remained after check_pin_manifest success');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exercises unreadable validator output fallback in render_pin_diag', () => {
    const validFixture = path.join(FIXTURES_DIR, 'valid.json');
    const dir = makeTmpDir();
    try {
      const runTmpDir = path.join(dir, 'tmp');
      const binDir = path.join(dir, 'bin');
      fs.mkdirSync(runTmpDir);
      fs.mkdirSync(binDir);

      // Stub wc that fails inside render_pin_diag when validator exits non-zero.
      const fakeWc = path.join(binDir, 'wc');
      fs.writeFileSync(fakeWc, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const fakeNode = path.join(dir, 'failing-node.sh');
      fs.writeFileSync(fakeNode, '#!/bin/sh\necho "validator error" >&2\nexit 2\n', { mode: 0o755 });

      const wcFailRes = runGatePinPreflight(validFixture, '', {
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: runTmpDir,
        TEST_GATE_NODE: fakeNode,
      });
      assert.equal(wcFailRes.status, 3);
      assert.equal(wcFailRes.stdout, '');
      assert.match(wcFailRes.stderr, /claim pin manifest validation failed .*: unreadable validator output\n$/);
      assert.deepEqual(fs.readdirSync(runTmpDir), []);

      // Also exercise the pipeline failure fallback in render_pin_diag (failing tr).
      fs.unlinkSync(fakeWc);
      const fakeTr = path.join(binDir, 'tr');
      fs.writeFileSync(fakeTr, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const trFailRes = runGatePinPreflight(validFixture, '', {
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: runTmpDir,
        TEST_GATE_NODE: fakeNode,
      });
      assert.equal(trFailRes.status, 3);
      assert.equal(trFailRes.stdout, '');
      assert.match(trFailRes.stderr, /claim pin manifest validation failed .*: unreadable validator output\n$/);
      assert.deepEqual(fs.readdirSync(runTmpDir), []);

      // Direct call on a non-existent diag file also returns the fixed fallback string.
      const directRes = runGatePinPreflight(
        validFixture,
        `printf "%s\\n" "$(render_pin_diag ${JSON.stringify(path.join(dir, 'missing-diag.bin'))})"`
      );
      assert.equal(directRes.status, 0, directRes.stderr);
      assert.equal(directRes.stdout.trim(), 'unreadable validator output');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

