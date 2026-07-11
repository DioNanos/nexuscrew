'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  generateService, generateLinux, generateMac, generateTermux,
  installService, installPath, installCommands, fileMode,
  escapeSystemdPath, escapeSystemdExec, escapeXml, shellQuote,
} = require('../lib/cli/service.js');

const ctx = (over = {}) => ({
  repoRoot: '/home/user/nexuscrew',
  nodeBin: '/usr/bin/node',
  port: 41820,
  home: '/home/user',
  uid: 1000,
  ...over,
});

function have(bin) {
  return String(process.env.PATH || '').split(path.delimiter).some((dir) => {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch (_) { return false; }
  });
}

// --- Linux systemd ---

test('generateLinux: struttura systemd --user', () => {
  const s = generateLinux(ctx());
  assert.match(s, /\[Unit\]/);
  assert.match(s, /\[Service\]/);
  assert.match(s, /\[Install\]/);
  assert.match(s, /WorkingDirectory=\/home\/user\/nexuscrew/);
  assert.doesNotMatch(s, /NEXUSCREW_PORT/, 'config.json resta la fonte autoritativa della porta');
  assert.match(s, /ExecStart=\/usr\/bin\/node .*\/bin\/nexuscrew\.js serve/);
  assert.match(s, /WantedBy=default\.target/);
});

test('generateLinux: escape %% su repo con % (hostile)', () => {
  const s = generateLinux(ctx({ repoRoot: '/home/user/100%repo' }));
  // WorkingDirectory escape % -> %%
  assert.match(s, /WorkingDirectory=\/home\/user\/100%%repo/);
  // nessun % singolo residuo nel WorkingDirectory
  assert.ok(!/WorkingDirectory=\/home\/user\/100%repo/.test(s));
});

test('generateLinux: ExecStart escape spazi (hostile path con spazio)', () => {
  const s = generateLinux(ctx({ repoRoot: '/home/user/my repo', nodeBin: '/usr/bin/node' }));
  // ExecStart: spazio nel path bin -> \space
  assert.match(s, /ExecStart=\/usr\/bin\/node .*my\\ repo.*serve/);
});

test('generateLinux: systemd-analyze verify passa con path reali (se disponibile)', { skip: !have('systemd-analyze') }, () => {
  const { repoRoot } = require('../lib/cli/platform.js');
  const s = generateLinux({ repoRoot: repoRoot(), nodeBin: process.execPath, port: 41820, home: os.homedir(), uid: 1000 });
  const tmp = path.join(os.tmpdir(), 'nc-svc-verify.service');
  fs.writeFileSync(tmp, s);
  execFileSync('systemd-analyze', ['verify', tmp], { stdio: 'pipe' }); // throw se fatal parse error
  fs.unlinkSync(tmp);
});

test('generateLinux: reject path con " (M3 hostile)', () => {
  assert.throws(() => generateLinux(ctx({ repoRoot: '/home/user/bad"path' })), /non supportati in systemd/);
});

test('generateLinux: reject path con $ (M3 hostile)', () => {
  assert.throws(() => generateLinux(ctx({ nodeBin: '/usr/bin/$node' })), /non supportati in systemd/);
});

test('generateLinux: space e % sono ok (non reject, M3)', () => {
  assert.doesNotThrow(() => generateLinux(ctx({ repoRoot: '/home/user/100% repo' })));
});

// --- Mac launchd ---

test('generateMac: struttura plist valida (key/string/array/dict)', () => {
  const s = generateMac(ctx());
  assert.match(s, /<\?xml/);
  assert.match(s, /<plist version="1\.0">/);
  assert.match(s, /<key>Label<\/key>\s*<string>com\.mmmbuto\.nexuscrew<\/string>/);
  assert.match(s, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.match(s, /<key>EnvironmentVariables<\/key>\s*<dict>/);
  assert.match(s, /<key>WorkingDirectory<\/key>\s*<string>/);
  assert.match(s, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(s, /<key>StandardOutPath<\/key>/);
  assert.match(s, /<key>StandardErrorPath<\/key>/);
  assert.match(s, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/bin<\/string>/);
});

test('generateMac: PATH usa dirname Node + Homebrew e bin di sistema', () => {
  const s = generateMac(ctx({ nodeBin: '/custom/node/bin/node' }));
  assert.match(s, /<key>PATH<\/key>\s*<string>\/custom\/node\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
});

test('generateMac: NESSUN <home> come elemento XML (R2)', () => {
  const s = generateMac(ctx());
  assert.ok(!s.includes('<home>'), 'il placeholder <home> non deve apparire come elemento XML');
  assert.ok(!s.includes('<home/>'));
});

test('generateMac: XML-escape home con & < > " (R2 hostile, log paths)', () => {
  const s = generateMac(ctx({ home: '/home/a&b<c>d"e' }));
  // StandardOutPath deve contenere la home escaped
  assert.match(s, /<key>StandardOutPath<\/key>\s*<string>\/home\/a&amp;b&lt;c&gt;d&quot;e\/\.nexuscrew\/nexuscrew\.log<\/string>/);
  // nessun raw &, <, > nei valori string (devono essere escaped)
  // (escludo i tag XML strutturali: cerco & non seguiti da amp/lt/gt/quot/#)
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(s), 'trovato & raw non-escaped');
});

test('generateMac: xmllint --noout (se disponibile)', { skip: !have('xmllint') }, () => {
  const s = generateMac(ctx());
  const tmp = path.join(os.tmpdir(), 'nc-svc.plist');
  fs.writeFileSync(tmp, s);
  execFileSync('xmllint', ['--noout', tmp], { stdio: 'pipe' });
  fs.unlinkSync(tmp);
});

// --- Termux boot ---

test('generateTermux: shebang + contesto completo', () => {
  const s = generateTermux(ctx());
  assert.match(s, /^#!\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
  assert.match(s, /export PATH=\/data\/data\/com\.termux\/files\/usr\/bin:\$PATH/);
  assert.match(s, /export HOME=\/data\/data\/com\.termux\/files\/home/);
  assert.doesNotMatch(s, /NEXUSCREW_PORT/, 'config.json resta la fonte autoritativa della porta');
  assert.match(s, /termux-wake-lock/);
  assert.match(s, /mkdir -p "\$HOME\/\.nexuscrew"/);
});

test('generateTermux: serve --pidfile + log redirect (R1.1 + R3)', () => {
  const s = generateTermux(ctx());
  assert.match(s, /serve --pidfile/); // non serve raw (R1.1)
  assert.match(s, />> "\$HOME\/\.nexuscrew\/nexuscrew\.log" 2>&1/); // log redirect (R3)
});

test('generateTermux: path assoluti shell-quoted (R1.2)', () => {
  const s = generateTermux(ctx({ repoRoot: '/data/data/com.termux/files/home/nexuscrew', nodeBin: '/data/data/com.termux/files/usr/bin/node' }));
  // exec '<nodeBin>' '<repoRoot>/bin/nexuscrew.js' serve --pidfile
  assert.match(s, /exec '\/data\/data\/com\.termux\/files\/usr\/bin\/node' '\/data\/data\/com\.termux\/files\/home\/nexuscrew\/bin\/nexuscrew\.js' serve --pidfile/);
});

test('generateTermux: sh -n valido (shell syntax check)', () => {
  const s = generateTermux(ctx());
  const tmp = path.join(os.tmpdir(), 'nc-boot.sh');
  fs.writeFileSync(tmp, s);
  execFileSync('sh', ['-n', tmp], { stdio: 'pipe' }); // throw se sintassi invalida
  fs.unlinkSync(tmp);
});

test('generateTermux: hostile path con spazi e $ ; ` shell-quoted (sh -n ok)', () => {
  const s = generateTermux(ctx({ repoRoot: '/home/user/my repo $x', nodeBin: '/usr/bin/node' }));
  const tmp = path.join(os.tmpdir(), 'nc-boot-hostile.sh');
  fs.writeFileSync(tmp, s);
  execFileSync('sh', ['-n', tmp], { stdio: 'pipe' }); // deve essere shell-valido
  fs.unlinkSync(tmp);
  // il path hostile e' shell-quoted (singolo quote)
  assert.match(s, /'\/home\/user\/my repo \$x\/bin\/nexuscrew\.js'/);
});

// --- escaping helpers ---

test('escapeXml: & < > "', () => {
  assert.equal(escapeXml('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
});

test('shellQuote: singolo quote + escape apostrofo', () => {
  assert.equal(shellQuote('simple'), "'simple'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

// --- installService ---

test('installService: mode file corretti per piattaforma', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const target = path.join(dir, 'nexuscrew.sh');
  const calls = [];
  installService('termux', generateTermux(ctx()), { ...ctx(), installPath: target }, { execImpl: (b, a) => calls.push([b, a]) });
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: linux unit mode 0644', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const target = path.join(dir, 'nexuscrew.service');
  installService('linux', generateLinux(ctx()), { ...ctx(), installPath: target }, { execImpl: () => {} });
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: pre-existing symlink -> reject (M3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'nexuscrew.sh');
  fs.writeFileSync(real, 'x');
  fs.symlinkSync(real, link);
  assert.throws(
    () => installService('termux', generateTermux(ctx()), { ...ctx(), installPath: link }, { execImpl: () => {} }),
    /symlink/i,
  );
  // real intatto (no follow)
  assert.equal(fs.readFileSync(real, 'utf8'), 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: dry-run non scrive nulla', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const target = path.join(dir, 'nexuscrew.sh');
  const calls = [];
  const r = installService('termux', generateTermux(ctx()), { ...ctx(), installPath: target }, { dryRun: true, execImpl: (b, a) => calls.push([b, a]) });
  assert.equal(r.written, false);
  assert.ok(!fs.existsSync(target));
  assert.equal(calls.length, 0); // nessun exec
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: atomic rename (no temp file residuo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const target = path.join(dir, 'nexuscrew.sh');
  installService('termux', generateTermux(ctx()), { ...ctx(), installPath: target }, { execImpl: () => {} });
  assert.ok(fs.existsSync(target));
  const tmps = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
  assert.equal(tmps.length, 0); // temp rinominato, non residuo
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: execImpl throw -> failures visibili (M1, no swallow)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fail-'));
  const target = path.join(dir, 'nexuscrew.service');
  const r = installService('linux', generateLinux(ctx()), { ...ctx(), installPath: target }, { execImpl: () => { throw new Error('systemctl down'); } });
  assert.equal(r.written, true); // file installato
  assert.ok(r.failures && r.failures.length > 0); // ma failures visibili (non ingoiati)
  assert.match(r.failures[0].error, /systemctl down/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installService: temp cleanup su write failure (m1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tmp-'));
  const target = path.join(dir, 'nexuscrew.service');
  const origWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = function (p, ...rest) {
    calls++;
    if (String(p).endsWith('.tmp.' + process.pid)) throw new Error('disk full');
    return origWrite.call(fs, p, ...rest);
  };
  try {
    assert.throws(
      () => installService('linux', generateLinux(ctx()), { ...ctx(), installPath: target }, { execImpl: () => {} }),
      /disk full/,
    );
    const tmps = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.equal(tmps.length, 0); // temp cleanup su failure
  } finally {
    fs.writeFileSync = origWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installService: exec systemctl/launchctl chiamati (mock)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inst-'));
  const target = path.join(dir, 'nexuscrew.service');
  const calls = [];
  installService('linux', generateLinux(ctx()), { ...ctx(), installPath: target }, { execImpl: (b, a) => calls.push([b, a]) });
  const bins = calls.map((c) => c[0]);
  assert.ok(bins.includes('systemctl'));
  assert.ok(calls.some((c) => c[1].includes('daemon-reload')));
  assert.ok(calls.some((c) => c[1].includes('enable')));
  assert.ok(calls.some((c) => c[1].includes('restart'))); // restart carica nuovo codice (drop-in)
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installCommands mac: bootout service-target, bootstrap domain-target', () => {
  const cmds = installCommands('mac', '/tmp/nexuscrew.plist', { uid: 501 });
  assert.deepEqual(cmds, [
    ['launchctl', ['bootout', 'gui/501/com.mmmbuto.nexuscrew']],
    ['launchctl', ['bootstrap', 'gui/501', '/tmp/nexuscrew.plist']],
  ]);
});

test('installService mac: bootout assente ignorato, bootstrap failure emerge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mac-'));
  const target = path.join(dir, 'nexuscrew.plist');
  let bootstrapFails = false;
  const execImpl = (_bin, args) => {
    if (args[0] === 'bootout') throw new Error('service not loaded');
    if (args[0] === 'bootstrap' && bootstrapFails) throw new Error('bootstrap failed');
  };
  const ok = installService('mac', generateMac(ctx()), { ...ctx(), installPath: target }, { execImpl });
  assert.deepEqual(ok.failures, []);
  bootstrapFails = true;
  const bad = installService('mac', generateMac(ctx()), { ...ctx(), installPath: target }, { execImpl });
  assert.equal(bad.failures.length, 1);
  assert.match(bad.failures[0].cmd, /bootstrap gui\/1000/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installPath + fileMode: per-platform', () => {
  assert.ok(installPath('linux', '/h').endsWith('.config/systemd/user/nexuscrew.service'));
  assert.ok(installPath('mac', '/h').endsWith('Library/LaunchAgents/com.mmmbuto.nexuscrew.plist'));
  assert.ok(installPath('termux', '/h').endsWith('.termux/boot/nexuscrew.sh'));
  assert.equal(fileMode('termux'), 0o700);
  assert.equal(fileMode('linux'), 0o644);
  assert.equal(fileMode('mac'), 0o644);
});
