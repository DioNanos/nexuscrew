'use strict';
// Publication on filesystems that deny link(2) (some Android mounts).
//
// The fallback is exclusive creation with verification through the same
// descriptor. It keeps exclusivity and non-overwrite, loses atomic appearance,
// and is entered ONLY for the five link errors below. Every caller that
// publishes with link(2) is exercised on real temporary directories with
// nothing but link(2) fault-injected.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const radici = require('../lib/fleet/vl-roots.js');
const locale = require('../lib/fleet/vl-claim-pin-local.js');
const lanci = require('../lib/fleet/launch-target.js');
const vlPin = require('../lib/cli/vl-pin.js');

const NEGATI = ['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const primitivo = () => require('../lib/fleet/exclusive-publish.js');

function dir(t, prefisso = 'nc-ld-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefisso));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  return d;
}

// Patches a method of fs for the rest of the test; restores it on exit.
function patch(t, nome, fn) {
  const orig = fs[nome];
  fs[nome] = fn(orig);
  t.after(() => { fs[nome] = orig; });
}

function negaLink(t, code) {
  const stato = { chiamate: 0 };
  patch(t, 'linkSync', () => () => {
    stato.chiamate += 1;
    const e = new Error(`${code}: link denied`);
    e.code = code;
    throw e;
  });
  return stato;
}

function conUmask(maschera, fn) {
  const prima = process.umask(maschera);
  try { return fn(); } finally { process.umask(prima); }
}

function coppia(d, contenuto) {
  const src = path.join(d, 'src.tmp');
  fs.writeFileSync(src, contenuto, { mode: 0o600 });
  return { src, dest: path.join(d, 'final') };
}

// ---------------------------------------------------------------- primitive

for (const code of NEGATI) {
  for (const maschera of [0o022, 0o002]) {
    test(`primitive: link ${code} (umask ${maschera.toString(8)}) -> created exclusively, 0600 for data and 0500 for executables`, (t) => {
      const d = dir(t);
      const bytes = Buffer.from('payload-bytes\n');
      negaLink(t, code);
      conUmask(maschera, () => {
        const a = coppia(d, bytes);
        const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes });
        assert.equal(r.status, 'published');
        assert.equal(r.via, 'create');
        assert.equal(fs.lstatSync(a.dest).mode & 0o777, 0o600);
        assert.deepEqual(fs.readFileSync(a.dest), bytes);
        const b = { src: a.src, dest: path.join(d, 'final-exec') };
        const re = primitivo().pubblicaEsclusiva({ src: b.src, dest: b.dest, bytes, executable: true });
        assert.equal(re.status, 'published');
        assert.equal(fs.lstatSync(b.dest).mode & 0o777, 0o500);
        assert.deepEqual(fs.readFileSync(b.dest), bytes);
      });
    });
  }
}

for (const code of ['EIO', 'ENOENT', 'ENOSPC', 'EROFS', 'ELOOP']) {
  test(`primitive: link ${code} does not open the fallback`, (t) => {
    const d = dir(t);
    const a = coppia(d, 'x');
    negaLink(t, code);
    const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('x') });
    assert.equal(r.status, 'failed-before-create');
    assert.equal(r.code, code);
    assert.equal(fs.existsSync(a.dest), false, 'nothing may be created for a non-allowlisted error');
  });
}

test('primitive: EEXIST from link is a conflict, not a fallback', (t) => {
  const d = dir(t);
  const a = coppia(d, 'x');
  negaLink(t, 'EEXIST');
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('x') });
  assert.equal(r.status, 'exists');
  assert.equal(fs.existsSync(a.dest), false);
});

test('primitive: a working link keeps the atomic path', (t) => {
  const d = dir(t);
  const a = coppia(d, 'x');
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('x') });
  assert.equal(r.status, 'published');
  assert.equal(r.via, 'link');
  assert.equal(fs.statSync(a.dest).ino, fs.statSync(a.src).ino);
});

test('primitive: an existing name is never overwritten nor truncated', (t) => {
  const d = dir(t);
  const a = coppia(d, 'new-content');
  fs.writeFileSync(a.dest, 'winner-content', { mode: 0o600 });
  const inoPrima = fs.statSync(a.dest).ino;
  negaLink(t, 'EACCES');
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('new-content') });
  assert.equal(r.status, 'exists');
  assert.equal(fs.readFileSync(a.dest, 'utf8'), 'winner-content');
  assert.equal(fs.statSync(a.dest).ino, inoPrima);
});

test('primitive: a symlink at the final name is refused and its target untouched', (t) => {
  const d = dir(t);
  const a = coppia(d, 'new-content');
  const bersaglio = path.join(d, 'target');
  fs.writeFileSync(bersaglio, 'target-content');
  fs.symlinkSync(bersaglio, a.dest);
  negaLink(t, 'EACCES');
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('new-content') });
  assert.notEqual(r.status, 'published');
  assert.equal(fs.readFileSync(bersaglio, 'utf8'), 'target-content');
  assert.equal(fs.lstatSync(a.dest).isSymbolicLink(), true);
});

test('primitive: two creators racing on one name, at most one wins and the winner is intact', (t) => {
  const d = dir(t);
  const a = coppia(d, 'content-a');
  const srcB = path.join(d, 'src-b.tmp');
  fs.writeFileSync(srcB, 'content-b', { mode: 0o600 });
  negaLink(t, 'EACCES');
  let esitoB = null;
  let dentro = false;
  patch(t, 'fsyncSync', (orig) => (fd) => {
    if (!dentro) {
      dentro = true;
      // The second creator arrives while the first one holds the final name.
      esitoB = primitivo().pubblicaEsclusiva({ src: srcB, dest: a.dest, bytes: Buffer.from('content-b') });
    }
    return orig(fd);
  });
  const esitoA = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes: Buffer.from('content-a') });
  assert.equal(esitoA.status, 'published');
  assert.equal(esitoB.status, 'exists');
  assert.equal(fs.readFileSync(a.dest, 'utf8'), 'content-a');
});

test('primitive: a short write that fails leaves the name in place and reports uncertainty', (t) => {
  const d = dir(t);
  const bytes = Buffer.from('0123456789abcdef');
  const a = coppia(d, bytes);
  negaLink(t, 'EACCES');
  let primo = true;
  patch(t, 'writeSync', (orig) => (fd, buf, off, len, pos) => {
    if (primo) { primo = false; return orig(fd, buf, off, 4, pos); }
    const e = new Error('EIO: injected'); e.code = 'EIO'; throw e;
  });
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes });
  assert.equal(r.status, 'uncertain-after-create');
  assert.equal(fs.existsSync(a.dest), true, 'an uncertain final name is kept for diagnosis');
  assert.equal(fs.statSync(a.dest).size, 4);
});

test('primitive: a failed fsync is never a success and keeps the name', (t) => {
  const d = dir(t);
  const bytes = Buffer.from('payload');
  const a = coppia(d, bytes);
  negaLink(t, 'EACCES');
  patch(t, 'fsyncSync', () => () => { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; });
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes, executable: true });
  assert.equal(r.status, 'uncertain-after-create');
  assert.equal(fs.existsSync(a.dest), true);
  assert.equal(fs.lstatSync(a.dest).mode & 0o777, 0o600, 'never executable before the bytes are synced');
});

test('primitive: a failed fchmod is never a success and keeps the name', (t) => {
  const d = dir(t);
  const bytes = Buffer.from('payload');
  const a = coppia(d, bytes);
  negaLink(t, 'EACCES');
  patch(t, 'fchmodSync', () => () => { const e = new Error('EPERM: injected'); e.code = 'EPERM'; throw e; });
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes, executable: true });
  assert.equal(r.status, 'uncertain-after-create');
  assert.equal(fs.existsSync(a.dest), true);
});

test('primitive: the executable bit appears only after the whole content is written and verified', (t) => {
  const d = dir(t);
  const bytes = Buffer.alloc(300000, 7);
  const a = coppia(d, bytes);
  negaLink(t, 'EACCES');
  const visto = [];
  patch(t, 'fchmodSync', (orig) => (fd, modo) => {
    const st = fs.fstatSync(fd);
    visto.push({ size: st.size, modoPrima: st.mode & 0o777, modo });
    return orig(fd, modo);
  });
  const r = primitivo().pubblicaEsclusiva({ src: a.src, dest: a.dest, bytes, executable: true });
  assert.equal(r.status, 'published');
  assert.deepEqual(visto, [{ size: bytes.length, modoPrima: 0o600, modo: 0o500 }]);
});

// ------------------------------------------------- objects: pinna / private

function sorgenteEseguibile(d, testo) {
  const source = path.join(d, 'tool.js');
  fs.writeFileSync(source, testo, { mode: 0o700 });
  return { source, hash: sha(Buffer.from(testo)) };
}

for (const code of NEGATI) {
  test(`pinna: link ${code} on the source path publishes a verified executable copy`, (t) => {
    const d = dir(t);
    const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n');
    negaLink(t, code);
    const stage = path.join(d, 'stage');
    const p = radici.pinna(source, hash, stage);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(sha(fs.readFileSync(p.path)), hash);
    assert.equal(fs.lstatSync(p.path).mode & 0o777, 0o500);
    assert.deepEqual(fs.readdirSync(stage).filter((n) => n.includes('.tmp-')), [], 'no private temporary is left behind');
    const r = spawnSync(process.execPath, [p.path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.stdout, 'A');
  });
}

test('pinna: a staging failure that is not a link denial is a staging error', (t) => {
  const d = dir(t);
  const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n');
  negaLink(t, 'ENOSPC');
  const p = radici.pinna(source, hash, path.join(d, 'stage'));
  assert.equal(p.ok, false);
  assert.equal(p.code, 'PIN_STAGE');
});

test('pinna: an interrupted fallback leaves a residue that every reader refuses, without repair', (t) => {
  const d = dir(t);
  const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n'.repeat(40));
  const stage = path.join(d, 'stage');
  negaLink(t, 'EACCES');
  const origWrite = fs.writeSync;
  let primo = true;
  fs.writeSync = (fd, buf, off, len, pos) => {
    // Only the final-name write is interrupted: it is the one using a position.
    if (typeof pos === 'number' && primo) { primo = false; return origWrite(fd, buf, off, 5, pos); }
    if (typeof pos === 'number') { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    return origWrite(fd, buf, off, len, pos);
  };
  let p1;
  try { p1 = radici.pinna(source, hash, stage); } finally { fs.writeSync = origWrite; }
  assert.equal(p1.ok, false);
  const residuo = path.join(stage, hash);
  assert.equal(fs.existsSync(residuo), true, 'the incomplete final name is kept');
  const prima = fs.readFileSync(residuo);
  const p2 = radici.pinna(source, hash, stage);
  assert.equal(p2.ok, false, 'a later call must not accept the residue');
  assert.deepEqual(fs.readFileSync(residuo), prima, 'the residue is neither repaired nor replaced');
});

test('pinna: a failed fsync of the fallback is not a pin', (t) => {
  const d = dir(t);
  const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n');
  negaLink(t, 'EACCES');
  const origFsync = fs.fsyncSync;
  let n = 0;
  fs.fsyncSync = (fd) => {
    // The private temporary syncs once; every later sync (final name, directory) fails.
    n += 1;
    if (n > 1) { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    return origFsync(fd);
  };
  let p;
  try { p = radici.pinna(source, hash, path.join(d, 'stage')); } finally { fs.fsyncSync = origFsync; }
  assert.equal(p.ok, false);
});

test('pinna: a pre-existing cache object that is not ours or not 0500 is refused and left alone', (t) => {
  const d = dir(t);
  const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n');
  const stage = path.join(d, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  const dest = path.join(stage, hash);
  fs.writeFileSync(dest, 'process.stdout.write("A")\n', { mode: 0o755 });
  const p = radici.pinna(source, hash, stage);
  assert.equal(p.ok, false, 'content is right but the object is not a qualified executable');
  assert.equal(fs.lstatSync(dest).mode & 0o777, 0o755, 'no chmod of a pre-existing object');
});

test('pinna: a symlink at the cache name is refused', (t) => {
  const d = dir(t);
  const { source, hash } = sorgenteEseguibile(d, 'process.stdout.write("A")\n');
  const stage = path.join(d, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.symlinkSync(source, path.join(stage, hash));
  const p = radici.pinna(source, hash, stage);
  assert.equal(p.ok, false);
  assert.equal(fs.lstatSync(path.join(stage, hash)).isSymbolicLink(), true);
});

// A large object (> 1 MiB) is registered privately; with link denied the copy
// is NOT the same inode as the private object, so the shortcut that trusts an
// inode match must not apply and the whole content must be hashed.
test('pinna: a large object copied without link is hashed in full and a corrupted copy is refused', (t) => {
  const d = dir(t);
  const grande = Buffer.alloc(1536 * 1024, 3);
  const source = path.join(d, 'big.bin');
  fs.writeFileSync(source, grande, { mode: 0o700 });
  const hash = sha(grande);
  negaLink(t, 'EACCES');
  radici.__prove.registraVerificato(source, hash);
  const privato = path.join(os.tmpdir(), `nc-vl-pin-${process.getuid()}`, hash);
  assert.equal(fs.lstatSync(privato).mode & 0o777, 0o500, 'private copy created without link');
  const stage = path.join(d, 'stage');
  const origFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const r = origFsync(fd);
    // The directory sync is the last step of the publication: corrupt one
    // byte of the finished copy right after it, as a failing disk would.
    if (fs.fstatSync(fd).isDirectory() && fs.existsSync(path.join(stage, hash))) {
      const f = path.join(stage, hash);
      fs.chmodSync(f, 0o600);
      const w = fs.openSync(f, 'r+');
      fs.writeSync(w, Buffer.from([9]), 0, 1, 1000);
      fs.closeSync(w);
      fs.chmodSync(f, 0o500);
    }
    return r;
  };
  let p;
  try { p = radici.pinna(source, hash, stage); } finally { fs.fsyncSync = origFsync; }
  assert.equal(p.ok, false, 'a copy that differs from the verified bytes must be refused');
});

// ------------------------------------------------------- provision / pin

function prefissoFinto(t) {
  const base = dir(t, 'nc-ld-prefix-');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const node = path.join(bin, 'node');
  const flock = path.join(bin, 'flock');
  fs.writeFileSync(node, `#!/bin/sh\ncase "$1" in --version) echo "v${process.versions.node}";; esac\n`, { mode: 0o500 });
  fs.writeFileSync(flock, '#!/bin/sh\necho "flock from util-linux 2.39.3"\n', { mode: 0o500 });
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { base, home, node, flock };
}

const provisiona = (p, extra = {}) => locale.provisiona({
  home: p.home, flock: p.flock, helperHash: 'a'.repeat(64), by: 'prova',
  deps: {
    platform: 'android', arch: 'arm64', execPath: p.node, versioneQualificata: vlPin.versioneQualificata, ...extra,
  },
});

for (const code of NEGATI) {
  test(`provision: link ${code} still reaches a valid pin without running unqualified sources`, (t) => {
    const p = prefissoFinto(t);
    negaLink(t, code);
    const r = provisiona(p);
    assert.equal(r.ok, true, JSON.stringify(r));
    const l = locale.leggi(p.home);
    assert.equal(l.stato, 'presente');
    assert.equal(l.pin.components.flock.version, '2.39.3');
    assert.equal(fs.lstatSync(locale.percorso(p.home)).mode & 0o777, 0o600);
  });
}

test('provision: a staging failure is reported as a staging failure, not as a bad flock version', (t) => {
  const p = prefissoFinto(t);
  negaLink(t, 'EIO');
  const r = provisiona(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_STAGE');
  assert.equal(r.component, 'flock');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
});

test('provision: a real unrecognised flock version still reports PIN_VERSION', (t) => {
  const p = prefissoFinto(t);
  fs.chmodSync(p.flock, 0o700);
  fs.writeFileSync(p.flock, '#!/bin/sh\necho "flock from another tool 1.0"\n');
  fs.chmodSync(p.flock, 0o500);
  const r = provisiona(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_VERSION');
});

test('provision: an existing pin is a conflict even when link is denied, bytes untouched', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p).ok, true);
  const file = locale.percorso(p.home);
  const prima = fs.readFileSync(file);
  const ino = fs.statSync(file).ino;
  negaLink(t, 'EACCES');
  const r = provisiona(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_EXISTS');
  assert.deepEqual(fs.readFileSync(file), prima);
  assert.equal(fs.statSync(file).ino, ino);
});

test('provision: an interrupted pin write leaves a residue the reader refuses and a second run does not replace', (t) => {
  const p = prefissoFinto(t);
  const origWrite = fs.writeSync;
  let primo = true;
  negaLink(t, 'EACCES');
  let armato = false;
  fs.writeSync = (fd, buf, off, len, pos) => {
    if (armato && typeof pos === 'number' && primo) { primo = false; return origWrite(fd, buf, off, 6, pos); }
    if (armato && typeof pos === 'number') { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    return origWrite(fd, buf, off, len, pos);
  };
  let r1;
  try {
    // The fault starts once the flock object is staged and its version read.
    r1 = provisiona(p, { versioneQualificata: (a) => { const v = vlPin.versioneQualificata(a); armato = true; return v; } });
  } finally { fs.writeSync = origWrite; }
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'PIN_WRITE');
  assert.notEqual(locale.leggi(p.home).stato, 'presente');
  const residuo = fs.readFileSync(locale.percorso(p.home));
  const r2 = provisiona(p);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'PIN_EXISTS');
  assert.deepEqual(fs.readFileSync(locale.percorso(p.home)), residuo);
});

test('provision: without a pin an up is still refused and does not create one', (t) => {
  const p = prefissoFinto(t);
  negaLink(t, 'EACCES');
  const r = radici.preparaPin(p.home, radici.MANIFEST, 'android-arm64', { execPath: p.node });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_UNCOVERED');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
});

// ------------------------------------------------------ operator act record

function atto(over = {}) {
  return {
    v: 1, schema: 'test', atto: 'confirm', esito: 'absent', cell: 'c', sessione: 's',
    launchId: '0123456789abcdef', recordSha256: 'b'.repeat(64), autorita: 'operator', motivo: 'm', ...over,
  };
}

function rootAtti(t) {
  const root = dir(t, 'nc-ld-act-');
  fs.chmodSync(root, 0o700);
  return root;
}

for (const code of NEGATI) {
  for (const maschera of [0o022, 0o002]) {
    test(`act record: link ${code} (umask ${maschera.toString(8)}) publishes 0600 bytes and a retry reuses them`, (t) => {
      const root = rootAtti(t);
      negaLink(t, code);
      conUmask(maschera, () => {
        const r = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 1000 });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.ripresa, false);
        const file = lanci.percorsoAtto(root, 'sess', '0123456789abcdef');
        const st = fs.lstatSync(file);
        assert.equal(st.mode & 0o777, 0o600);
        assert.equal(st.nlink, 1);
        assert.deepEqual(fs.readFileSync(file), r.bytes);
        const r2 = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 2000 });
        assert.equal(r2.ok, true);
        assert.equal(r2.ripresa, true);
        assert.equal(r2.ts, 1000);
        assert.deepEqual(r2.bytes, r.bytes);
      });
    });
  }
}

test('act record: a different decision on a published name is a conflict and changes nothing', (t) => {
  const root = rootAtti(t);
  negaLink(t, 'EACCES');
  const r = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 1000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = lanci.percorsoAtto(root, 'sess', '0123456789abcdef');
  const prima = fs.readFileSync(file);
  const ino = fs.statSync(file).ino;
  const r2 = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto({ esito: 'present' }), { ora: 3000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.codice, 'atto-conflitto');
  assert.deepEqual(fs.readFileSync(file), prima);
  assert.equal(fs.statSync(file).ino, ino);
});

test('act record: an interrupted write is a failure and the truncated name is never reused or mutated', (t) => {
  const root = rootAtti(t);
  negaLink(t, 'EACCES');
  const origWrite = fs.writeSync;
  let primo = true;
  fs.writeSync = (fd, buf, off, len, pos) => {
    if (typeof pos === 'number' && primo) { primo = false; return origWrite(fd, buf, off, 5, pos); }
    if (typeof pos === 'number') { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    return origWrite(fd, buf, off, len, pos);
  };
  let r1;
  try { r1 = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 1000 }); } finally { fs.writeSync = origWrite; }
  assert.equal(r1.ok, false);
  const file = lanci.percorsoAtto(root, 'sess', '0123456789abcdef');
  assert.equal(fs.existsSync(file), true);
  const troncato = fs.readFileSync(file);
  const r2 = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.codice, 'atto-non-qualificato');
  assert.deepEqual(fs.readFileSync(file), troncato);
});

test('act record: a failed fsync is never a published act', (t) => {
  const root = rootAtti(t);
  negaLink(t, 'EACCES');
  const origFsync = fs.fsyncSync;
  let n = 0;
  fs.fsyncSync = (fd) => {
    n += 1;
    if (n > 1) { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    return origFsync(fd);
  };
  let r;
  try { r = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 1000 }); } finally { fs.fsyncSync = origFsync; }
  assert.equal(r.ok, false);
});

test('act record: a non-link error is not routed to the fallback', (t) => {
  const root = rootAtti(t);
  negaLink(t, 'ENOSPC');
  const r = lanci.scriviAttoOperatore(root, 'sess', '0123456789abcdef', atto(), { ora: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'atto-scrittura');
  assert.equal(fs.existsSync(lanci.percorsoAtto(root, 'sess', '0123456789abcdef')), false);
});

test('primitive: exclusive create publication attaches created {dev, ino} on published and preserves it on uncertain-after-create', (t) => {
  const d = dir(t);
  const bytes = Buffer.from('created-metadata-bytes\n');
  negaLink(t, 'EACCES');

  const okPair = coppia(d, bytes);
  const pub = primitivo().pubblicaEsclusiva({ src: okPair.src, dest: okPair.dest, bytes, executable: true });
  assert.equal(pub.status, 'published');
  assert.equal(pub.via, 'create');
  const stPub = fs.lstatSync(okPair.dest);
  assert.deepEqual(pub.created, { dev: stPub.dev, ino: stPub.ino });

  const uncPair = { src: okPair.src, dest: path.join(d, 'final-uncertain') };
  const origFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    const e = new Error('EIO: injected');
    e.code = 'EIO';
    throw e;
  };
  let unc;
  try {
    unc = primitivo().pubblicaEsclusiva({ src: uncPair.src, dest: uncPair.dest, bytes, executable: true });
  } finally {
    fs.fsyncSync = origFsync;
  }
  assert.equal(unc.status, 'uncertain-after-create');
  const stUnc = fs.lstatSync(uncPair.dest);
  assert.deepEqual(unc.created, { dev: stUnc.dev, ino: stUnc.ino });

  const unknownPair = { src: okPair.src, dest: path.join(d, 'final-unknown-fstat') };
  const origFstat = fs.fstatSync;
  let injected = false;
  fs.fstatSync = (fd) => {
    if (!injected) {
      injected = true;
      const e = new Error('EIO: injected fstat');
      e.code = 'EIO';
      throw e;
    }
    return origFstat(fd);
  };
  let unk;
  try {
    unk = primitivo().pubblicaEsclusiva({ src: unknownPair.src, dest: unknownPair.dest, bytes, executable: true });
  } finally {
    fs.fstatSync = origFstat;
  }
  assert.equal(unk.status, 'uncertain-after-create');
  assert.equal(unk.created, undefined);
});
