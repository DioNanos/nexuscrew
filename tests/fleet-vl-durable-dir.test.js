'use strict';

// Qualification of the durable chain: the rings are checked as objects (no
// follow, owner, mode) and never adopted, replaced or chmodded. The protection
// is established from the top down: an own ring at 0700 whose ancestors are
// qualified protects the subtree below it, and only inside such a subtree may a
// pre-existing own ring be writable by group or other. Everything is built under
// the run's TMPDIR.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = require('../lib/fleet/vl-host-stop.js');

const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
// Android's system identity, the application's own uid on a device, and an
// unrelated one for the negatives. The application uid is simulated, never taken
// from the machine: the test user may itself be 1000.
const UID_SISTEMA = 1000;
const UID_APP = 10475;
const UID_ESTRANEO = UID === 6000 ? 6001 : 6000;

function creaRadice(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dur-'));
  t.after(() => {
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function catena(root) {
  const home = path.join(root, 'home');
  const nexus = path.join(home, '.nexuscrew');
  const cells = path.join(nexus, 'vl-cells');
  const cell = path.join(cells, 'Cella');
  fs.mkdirSync(nexus, { recursive: true, mode: 0o700 });
  fs.chmodSync(nexus, 0o700);
  return { home, nexus, cells, cell };
}

// A spy over the injected fs: it counts syncs and every mutating primitive
// that could tighten or replace an object.
function spia(over = {}) {
  const sync = [];
  const mutanti = [];
  const impl = {
    ...fs,
    fsyncSync: (fd) => { sync.push(fd); return fs.fsyncSync(fd); },
    chmodSync: (...a) => { mutanti.push(['chmodSync', a[0]]); return fs.chmodSync(...a); },
    fchmodSync: (...a) => { mutanti.push(['fchmodSync', a[0]]); return fs.fchmodSync(...a); },
    unlinkSync: (...a) => { mutanti.push(['unlinkSync', a[0]]); return fs.unlinkSync(...a); },
    renameSync: (...a) => { mutanti.push(['renameSync', a[0]]); return fs.renameSync(...a); },
    ...over,
  };
  return { impl, sync, mutanti };
}

// A Stats look-alike with a different identity: the same prototype (so the type
// answers stay real) and the given fields replaced.
function identita(st, patch) {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch);
}

// An lstat that answers with a doctored identity for the given absolute paths.
function lstatConIdentita(mappa) {
  const assoluta = new Map(Object.entries(mappa).map(([k, v]) => [path.resolve(k), v]));
  return (p, opts) => {
    const st = fs.lstatSync(p, opts);
    const patch = assoluta.get(path.resolve(p));
    return patch ? identita(st, patch) : st;
  };
}

// The run builds every fixture under a 0700 TMPDIR of ours, which is already an
// anchor: to exercise the shared stretch, every ancestor of the fixture root
// answers as a root-owned ring at 0755, and the fixture root itself carries the
// identity the case needs.
function sopraRadice(root) {
  const mappa = {};
  let p = path.dirname(path.resolve(root));
  for (;;) {
    mappa[p] = { uid: 0, mode: 0o40755 };
    const padre = path.dirname(p);
    if (padre === p) break;
    p = padre;
  }
  return mappa;
}

// The host platform is read in a single place inside the module, so the
// exception can be exercised without a phone: the value is replaced and restored
// in a finally, never passed as a parameter.
function conPiattaforma(valore, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: valore, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

// The current user is read in a single place inside the module as well, so the
// application's uid and the root user can be exercised without running as them.
// The value is replaced and restored in a finally, never passed as a parameter.
function conUid(valore, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { value: () => valore, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'getuid', desc);
  }
}

test('creates the private chain, every ring is a real directory at 0700 and is synced', (t) => {
  assert.equal(typeof host.assicuraDirDurevole, 'function', 'the helper is exported');
  const root = creaRadice(t);
  const { nexus, cells, cell } = catena(root);
  const { impl, sync, mutanti } = spia();

  host.assicuraDirDurevole(impl, cell);

  for (const anello of [nexus, cells, cell]) {
    const st = fs.lstatSync(anello);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), `ring ${path.basename(anello)} is a real directory`);
    assert.equal(st.mode & 0o777, 0o700, `ring ${path.basename(anello)} is private`);
  }
  // Each ring is synced itself and as an entry of its own parent.
  assert.ok(sync.length >= 6, `syncs of the three rings and their parents (saw ${sync.length})`);
  assert.deepEqual(mutanti, [], 'the helper chmods, renames and unlinks nothing');
});

test('a symbolic ring is refused before anything is created under the link target', (t) => {
  const root = creaRadice(t);
  const { nexus, cells, cell } = catena(root);
  const altrove = path.join(root, 'altrove');
  fs.mkdirSync(altrove, { recursive: true, mode: 0o700 });
  fs.symlinkSync(altrove, cells);
  const { impl, mutanti } = spia();

  assert.throws(
    () => host.assicuraDirDurevole(impl, cell),
    (e) => e.code === 'ENOTDIR',
    'a symlink ring is not a ring',
  );
  assert.equal(fs.existsSync(path.join(altrove, 'Cella')), false, 'nothing was created through the link');
  assert.ok(fs.lstatSync(cells).isSymbolicLink(), 'the link is left in place, never replaced');
  assert.ok(fs.lstatSync(nexus).isDirectory(), 'the real ring above it is untouched');
  assert.deepEqual(mutanti, [], 'no chmod on the link or on its target');
});

test('a ring owned by another user is refused and nothing is created below it', (t) => {
  const root = creaRadice(t);
  const { nexus, cells, cell } = catena(root);
  const estraneo = (typeof process.getuid === 'function' ? process.getuid() : 0) + 1;
  const { impl, mutanti } = spia({
    lstatSync: (p, opts) => {
      const st = fs.lstatSync(p, opts);
      if (path.resolve(p) !== nexus) return st;
      return identita(st, { uid: estraneo });
    },
  });

  assert.throws(
    () => host.assicuraDirDurevole(impl, cell),
    (e) => e.code === 'EPERM',
    'a ring of another owner is not adopted',
  );
  assert.equal(fs.existsSync(cells), false, 'no ring was created under a foreign ancestor');
  assert.deepEqual(mutanti, [], 'no chmod on the foreign object');
});

test('a new ring whose mode differs from 0700 is refused: the object is checked, not the request', (t) => {
  const root = creaRadice(t);
  const { cells, cell } = catena(root);
  const { impl } = spia({
    // A filesystem that ignores the requested mode: the ring appears less
    // private than asked, and the qualification must read the object.
    mkdirSync: (p, opts) => fs.mkdirSync(p, { ...opts, mode: 0o777 }),
  });

  assert.throws(
    () => host.assicuraDirDurevole(impl, cell),
    (e) => e.code === 'ESTALE',
    'a ring created without the private mode is refused',
  );
  assert.ok(fs.existsSync(cells), 'the ring exists');
  assert.notEqual(fs.lstatSync(cells).mode & 0o777, 0o700, 'and its mode is not the requested one');
});

test('outside the shared boundary an existing ancestor is neither adopted nor tightened', (t) => {
  const root = creaRadice(t);
  const condiviso = path.join(root, 'x', 'y');
  fs.mkdirSync(condiviso, { recursive: true, mode: 0o700 });
  fs.chmodSync(condiviso, 0o755);
  const prima = fs.lstatSync(condiviso);
  const { impl, mutanti } = spia();

  const foglia = path.join(condiviso, 'z');
  host.assicuraDirDurevole(impl, foglia);

  assert.equal(fs.lstatSync(foglia).mode & 0o777, 0o700, 'the ring this call created is private');
  const dopo = fs.lstatSync(condiviso);
  assert.equal(dopo.mode & 0o777, 0o755, 'the pre-existing shared ancestor keeps its mode');
  assert.equal(dopo.ino, prima.ino, 'and is the same object, not a replacement');
  assert.deepEqual(mutanti, [], 'no chmod on the shared ancestor');
});

test('a pre-existing private ring at 0755 is accepted without being tightened', (t) => {
  const root = creaRadice(t);
  const { nexus, cells, cell } = catena(root);
  fs.chmodSync(nexus, 0o755);
  const { impl, mutanti } = spia();

  host.assicuraDirDurevole(impl, cell);

  assert.equal(fs.lstatSync(nexus).mode & 0o777, 0o755, 'the accepted ancestor keeps its mode');
  assert.equal(fs.lstatSync(cells).mode & 0o777, 0o700, 'the new ring is private');
  assert.equal(fs.lstatSync(cell).mode & 0o777, 0o700, 'the leaf is private');
  assert.deepEqual(mutanti, [], 'accepting is not tightening: no chmod');
});

// T1 (+): an own ring writable by group or other is legitimate below an anchor
// that makes the subtree unreachable by pathname, inside and outside the
// nominal boundary.
test('an own ring at 0775 below a private anchor is accepted, with and without the boundary name', (t) => {
  for (const conConfine of [true, false]) {
    const root = creaRadice(t);
    const { cells, cell } = catena(root);
    const largo = conConfine ? cells : path.join(root, 'largo');
    const foglia = conConfine ? cell : path.join(largo, 'foglia');
    fs.mkdirSync(largo, { recursive: true, mode: 0o700 });
    fs.chmodSync(largo, 0o775);
    const prima = fs.lstatSync(largo);
    const { impl, mutanti } = spia();

    host.assicuraDirDurevole(impl, foglia);

    const dopo = fs.lstatSync(largo);
    assert.equal(dopo.mode & 0o777, 0o775, `0775 ring accepted${conConfine ? ' with' : ' without'} the boundary name, mode untouched`);
    assert.equal(dopo.ino, prima.ino, 'and the same object');
    assert.equal(fs.lstatSync(foglia).mode & 0o777, 0o700, 'the new leaf is private');
    assert.deepEqual(mutanti, [], 'no chmod anywhere');
  }
});

// T14 (rebuilt from the old negative): a chain with no private anchor is not
// protected, and the refusal lands BEFORE anything is created below.
test('a chain with no private anchor is refused before anything is created', (t) => {
  const root = creaRadice(t);
  fs.chmodSync(root, 0o777);
  const { impl, mutanti } = spia({ lstatSync: lstatConIdentita(sopraRadice(root)) });
  const foglia = path.join(root, 'a', 'b', 'c');

  assert.throws(
    () => host.assicuraDirDurevole(impl, foglia),
    (e) => e.code === 'ESTALE',
    'an own ring writable by others cannot start a protected chain',
  );
  assert.equal(fs.existsSync(path.join(root, 'a')), false, 'nothing was created under it');
  assert.equal(fs.lstatSync(root).mode & 0o777, 0o777, 'the ring is left exactly as found');
  assert.deepEqual(mutanti, [], 'a pre-existing ring is never chmodded');
});

// T4 (-): an anchor that a third party could replace does not protect anything.
test('an anchor below a substitutable ring is not accepted', (t) => {
  const root = creaRadice(t);
  fs.chmodSync(root, 0o777);
  const protetto = path.join(root, 'p');
  fs.mkdirSync(protetto, { recursive: true, mode: 0o700 });
  fs.chmodSync(protetto, 0o700);
  const { impl } = spia({ lstatSync: lstatConIdentita(sopraRadice(root)) });

  assert.throws(
    () => host.assicuraDirDurevole(impl, path.join(protetto, 'x')),
    (e) => e.code === 'ESTALE',
    'our 0700 inside our 0777 is not an anchor',
  );
  assert.equal(fs.existsSync(path.join(protetto, 'x')), false, 'nothing was created');

  // The same at the top: a fake root ring writable by its group without the
  // sticky bit cannot be crossed.
  const root2 = creaRadice(t);
  const { impl: impl2 } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root2), [root2]: { uid: 0, mode: 0o40777 } }),
  });
  assert.throws(
    () => host.assicuraDirDurevole(impl2, path.join(root2, 'x')),
    (e) => e.code === 'ESTALE',
    'root writable by group or other without the sticky bit is refused',
  );
  assert.equal(fs.existsSync(path.join(root2, 'x')), false, 'nothing was created');
});

// T6 (-): a shared component may be root, never another ordinary user.
test('a ring at 0755 of another non-root owner is refused', (t) => {
  const root = creaRadice(t);
  const { impl, mutanti } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: UID_ESTRANEO, mode: 0o40755 } }),
  });
  const foglia = path.join(root, 'x', 'y');

  assert.throws(
    () => host.assicuraDirDurevole(impl, foglia),
    (e) => e.code === 'EPERM',
    'a foreign non-root ring is never traversed',
  );
  assert.equal(fs.existsSync(path.join(root, 'x')), false, 'nothing was created');
  assert.deepEqual(mutanti, [], 'no chmod on the foreign object');
});

// T7 (-): root is accepted while it is not writable by group or other, or while
// it carries the sticky bit; otherwise it is a door anyone can use.
test('a fake root ring writable by group without the sticky bit is refused', (t) => {
  const root = creaRadice(t);
  const { impl } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: 0, mode: 0o40770 } }),
  });
  assert.throws(
    () => host.assicuraDirDurevole(impl, path.join(root, 'x')),
    (e) => e.code === 'ESTALE',
    'root writable by its group and without the sticky bit is refused',
  );
  assert.equal(fs.existsSync(path.join(root, 'x')), false, 'nothing was created');
});

// T8 (+): root at 0755 and a sticky root ring are accepted above our subtree.
test('a fake root ring at 0755 and a sticky one are accepted above our own qualified subtree', (t) => {
  for (const modo of [0o40755, 0o41777]) {
    const root = creaRadice(t);
    const { impl, mutanti } = spia({
      lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: 0, mode: modo } }),
    });
    const foglia = path.join(root, 'a', 'b');
    host.assicuraDirDurevole(impl, foglia);
    assert.equal(fs.lstatSync(foglia).mode & 0o777, 0o700, `accepted with root at ${(modo & 0o7777).toString(8)}`);
    assert.deepEqual(mutanti, [], 'no chmod on the shared rings');
  }
});

// T9 (-): an ancestor that changes owner between the two qualifications is a
// replacement, not a chain.
test('a ring that changes owner between the two qualifications is refused', (t) => {
  const root = creaRadice(t);
  let letture = 0;
  const sopra = sopraRadice(root);
  const impl = {
    ...fs,
    lstatSync: (p, opts) => {
      const st = fs.lstatSync(p, opts);
      if (path.resolve(p) === path.resolve(root)) {
        letture += 1;
        return letture === 1
          ? identita(st, { uid: 0, mode: 0o40755 })
          : identita(st, { uid: UID_ESTRANEO, mode: 0o40755 });
      }
      const patch = sopra[path.resolve(p)];
      return patch ? identita(st, patch) : st;
    },
  };
  assert.throws(
    () => host.assicuraDirDurevole(impl, path.join(root, 'a', 'b')),
    (e) => e.code === 'EPERM',
    'the ring that changed owner is refused at the second qualification',
  );
  assert.ok(letture >= 2, 'the ring was really read twice');
  assert.deepEqual(fs.readdirSync(path.join(root, 'a', 'b')), [], 'nothing was written in the created leaf');
});

// T11 (-): a ring replaced by a symbolic link while the tree is being created is
// refused, and the link target is never adopted.
test('a ring replaced by a symbolic link during the creation is refused without adopting the target', (t) => {
  const root = creaRadice(t);
  const { cells, cell } = catena(root);
  const altrove = path.join(root, 'altrove');
  fs.mkdirSync(altrove, { recursive: true, mode: 0o700 });
  const { impl } = spia({
    mkdirSync: (p, opts) => {
      fs.mkdirSync(p, opts);
      if (path.resolve(p) !== path.resolve(cell)) return;
      fs.rmSync(cells, { recursive: true, force: true });
      fs.symlinkSync(altrove, cells);
    },
  });

  assert.throws(
    () => host.assicuraDirDurevole(impl, cell),
    (e) => e.code === 'ENOTDIR',
    'the ring that became a link is refused at the second qualification',
  );
  assert.deepEqual(fs.readdirSync(altrove), [], 'nothing was written or synced through the link');
  assert.ok(fs.lstatSync(cells).isSymbolicLink(), 'the substitute is left as found');
});

// C1 (-): a ring that existed before the creation and answers with ANOTHER real
// directory at the second qualification — same name, same owner, same mode,
// different object — is a replacement: refused, never synced.
test('a pre-existing ring replaced by another real directory between the qualifications is refused without a sync', (t) => {
  const root = creaRadice(t);
  const { nexus, cells, cell } = catena(root);
  const sparito = path.join(root, 'nexus-precedente');
  let sync = 0;
  let sostituito = false;
  const { impl, mutanti } = spia({
    mkdirSync: (p, opts) => {
      fs.mkdirSync(p, opts);
      if (sostituito) return;
      sostituito = true;
      // The whole chain is rebuilt around a substitute that has the same name,
      // the same owner and the same mode: only the identity distinguishes it.
      // The subtree is recreated so that the only difference between the two
      // qualifications is the object of one ring, not a missing descendant.
      fs.renameSync(nexus, sparito);
      fs.mkdirSync(cells, { recursive: true, mode: 0o700 });
      fs.mkdirSync(cell, { mode: 0o700 });
    },
    fsyncSync: (fd) => { sync += 1; return fs.fsyncSync(fd); },
  });

  assert.throws(
    () => host.assicuraDirDurevole(impl, cell),
    (e) => e.code === 'ESTALE',
    'the ring that changed object between the qualifications is refused',
  );
  assert.equal(sync, 0, 'nothing was synced, so the substitute was never attested');
  assert.equal(fs.lstatSync(nexus).ino === fs.lstatSync(sparito).ino, false, 'the substitute is really another object');
  assert.equal(fs.lstatSync(nexus).mode & 0o777, 0o700, 'the substitute has the same mode as the ring it replaced');
  assert.deepEqual(mutanti, [], 'nothing is tightened, removed or renamed by the helper');
});

// T12 (-): a descriptor that is not the qualified ring is refused BEFORE the
// sync; the same holds for a descriptor on a regular file.
test('a descriptor that is not the qualified ring is refused before the sync', (t) => {
  const root = creaRadice(t);
  const { cells, cell } = catena(root);
  const altro = path.join(root, 'altro');
  fs.mkdirSync(altro, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x', { mode: 0o600 });

  // A descriptor on another directory passes the open and is refused by the
  // identity comparison; a descriptor on a regular file cannot even be opened as
  // a directory. Either way the refusal lands before the sync.
  for (const [caso, sostituto, aperto] of [['another directory', altro, true], ['a regular file', file, false]]) {
    const fdSbagliati = [];
    const sincronizzati = [];
    let syncPrimaDelSostituto = null;
    const { impl } = spia({
      openSync: (p, flags, mode) => {
        if (path.resolve(p) !== path.resolve(cells)) return fs.openSync(p, flags, mode);
        syncPrimaDelSostituto = sincronizzati.length;
        const fd = fs.openSync(sostituto, flags, mode);
        fdSbagliati.push(fd);
        return fd;
      },
      fsyncSync: (fd) => { sincronizzati.push(fd); return fs.fsyncSync(fd); },
    });
    assert.throws(
      () => host.assicuraDirDurevole(impl, cell),
      (e) => e.code === 'ESTALE',
      `a descriptor on ${caso} is not the qualified ring`,
    );
    assert.equal(fs.existsSync(path.join(cell, 'host-context.json')), false, 'nothing was written');
    assert.equal(fdSbagliati.length, aperto ? 1 : 0, `descriptors opened on ${caso}`);
    // Descriptor numbers are reused, so what proves the order is the count: no
    // sync happened after the substitute was opened.
    assert.ok(syncPrimaDelSostituto !== null, `the substitute was reached (${caso})`);
    assert.equal(sincronizzati.length, syncPrimaDelSostituto, `no sync after the ${caso}`);
  }
});

// T13 (+): every descriptor opened for a sync is closed even when the sync fails.
test('every descriptor is closed even when the sync fails', (t) => {
  const root = creaRadice(t);
  const { cells, cell } = catena(root);
  let aperti = 0;
  let chiusi = 0;
  const { impl } = spia({
    openSync: (p, flags, mode) => { aperti += 1; return fs.openSync(p, flags, mode); },
    closeSync: (fd) => { chiusi += 1; return fs.closeSync(fd); },
    fsyncSync: () => {
      const e = new Error('eio');
      e.code = 'EIO';
      throw e;
    },
  });

  assert.throws(() => host.assicuraDirDurevole(impl, cell), (e) => e.code === 'EIO', 'the sync error rises');
  assert.ok(aperti > 0, 'at least one descriptor was opened');
  assert.equal(chiusi, aperti, 'every open descriptor was closed');
  assert.equal(fs.existsSync(path.join(cells, 'Cella', 'host-context.json')), false, 'no file was written');
});

// The chain of an Android device. The shared rings above the data directory are
// the system identity, writable by their own group, and a private anchor of the
// application is what protects the subtree below. The application uid is
// simulated: on a phone it is never the system one, and the test user's uid must
// not decide the case.
function catenaAndroid(t, uidApp) {
  const root = creaRadice(t); // stands for the shared parent of the data directory
  const dataData = path.join(root, 'data'); // stands for the data directory itself
  const anchor = path.join(dataData, 'anch');
  const sotto = path.join(anchor, 'sotto');
  fs.mkdirSync(sotto, { recursive: true, mode: 0o700 });
  fs.chmodSync(anchor, 0o700);
  fs.chmodSync(sotto, 0o700);
  // The shared stretch must really be shared: the run's TMPDIR is a 0700 ring of
  // ours, and on Android it would also be an anchor of ours, hiding the rule
  // under test. Above the fixture root everything answers as root at 0755.
  const mappa = {
    ...sopraRadice(root),
    [root]: { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o40771 },
    [dataData]: { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o40771 },
    [anchor]: { uid: uidApp },
    [sotto]: { uid: uidApp },
  };
  return { root, dataData, anchor, sotto, mappa };
}

test('on Android the system rings above the anchor are accepted, with no chmod anywhere', (t) => {
  const { anchor, sotto, mappa } = catenaAndroid(t, UID_APP);
  const foglia = path.join(sotto, 'foglia');
  // The ring created by the call belongs to the application, as on a device.
  const { impl, mutanti } = spia({ lstatSync: lstatConIdentita({ ...mappa, [foglia]: { uid: UID_APP } }) });

  conUid(UID_APP, () => conPiattaforma('android', () => {
    host.assicuraDirDurevole(impl, foglia);
  }));

  assert.equal(fs.lstatSync(anchor).mode & 0o777, 0o700, 'the anchor is untouched');
  assert.equal(fs.lstatSync(sotto).mode & 0o777, 0o700, 'the ring below the anchor is untouched');
  assert.deepEqual(mutanti, [], 'the system rings are never chmodded');
});

test('on Linux the system identity is not shared infrastructure', (t) => {
  const root = creaRadice(t);
  const { impl } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o40771 } }),
  });

  conUid(UID_APP, () => {
    assert.throws(
      () => host.assicuraDirDurevole(impl, path.join(root, 'a')),
      (e) => e.code === 'EPERM',
      'the Android exception does not exist on Linux: a foreign owner is refused',
    );
  });
  assert.equal(fs.existsSync(path.join(root, 'a')), false, 'nothing was created');
});

test('on Android a system-like ring is refused when the owner, the group or the others bits do not match', (t) => {
  const casi = [
    ['another owner', { uid: UID_ESTRANEO, gid: UID_SISTEMA, mode: 0o40771 }, 'EPERM'],
    ['another group', { uid: UID_SISTEMA, gid: UID_ESTRANEO, mode: 0o40771 }, 'EPERM'],
    ['write for others with the sticky bit', { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o41777 }, 'ESTALE'],
  ];
  for (const [caso, patch, code] of casi) {
    const root = creaRadice(t);
    const { impl } = spia({
      lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: patch }),
    });
    conUid(UID_APP, () => conPiattaforma('android', () => {
      assert.throws(
        () => host.assicuraDirDurevole(impl, path.join(root, 'a')),
        (e) => e.code === code,
        `a system-like ring with ${caso} is refused`,
      );
    }));
    assert.equal(fs.existsSync(path.join(root, 'a')), false, `nothing was created (${caso})`);
  }
});

test('on Android a symbolic system ring is refused like any other link', (t) => {
  const root = creaRadice(t);
  const altrove = path.join(root, 'altrove');
  fs.mkdirSync(altrove, { recursive: true, mode: 0o700 });
  fs.symlinkSync(altrove, path.join(root, 'data'));
  const { impl } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o40771 } }),
  });
  conUid(UID_APP, () => conPiattaforma('android', () => {
    assert.throws(
      () => host.assicuraDirDurevole(impl, path.join(root, 'data', 'a')),
      (e) => e.code === 'ENOTDIR',
      'a symbolic system ring is not a ring',
    );
  }));
  assert.deepEqual(fs.readdirSync(altrove), [], 'nothing was created through the link');
});

test('on Android a system-owned ring below the anchor is refused by the owner rule', (t) => {
  const { sotto, mappa } = catenaAndroid(t, UID_APP);
  const sistemaSotto = path.join(sotto, 'sistema');
  fs.mkdirSync(sistemaSotto, { recursive: true, mode: 0o700 });
  const { impl } = spia({
    lstatSync: lstatConIdentita({ ...mappa, [sistemaSotto]: { uid: UID_SISTEMA, gid: UID_SISTEMA } }),
  });

  conUid(UID_APP, () => conPiattaforma('android', () => {
    assert.throws(
      () => host.assicuraDirDurevole(impl, path.join(sistemaSotto, 'foglia')),
      (e) => e.code === 'EPERM',
      'below the anchor the owner is the application, never the system user',
    );
  }));
  assert.equal(fs.existsSync(path.join(sistemaSotto, 'foglia')), false, 'nothing was created');
});

// The current owner keeps its anchor, and its rights below it, even when its uid
// is numerically the system one: on a phone that cannot happen, but the rule is
// the owner, not a label.
test('on Android the current owner below its anchor is accepted even when its uid is the system one', (t) => {
  const root = creaRadice(t);
  const anchor = path.join(root, 'anch');
  const sotto = path.join(anchor, 'sotto');
  fs.mkdirSync(sotto, { recursive: true, mode: 0o700 });
  const foglia = path.join(sotto, 'foglia');
  const mappa = {
    ...sopraRadice(root),
    [root]: { uid: UID_SISTEMA, gid: UID_SISTEMA, mode: 0o40755 },
    [anchor]: { uid: UID_SISTEMA, gid: UID_SISTEMA },
    [sotto]: { uid: UID_SISTEMA, gid: UID_SISTEMA },
    [foglia]: { uid: UID_SISTEMA, gid: UID_SISTEMA },
  };
  const { impl, mutanti } = spia({ lstatSync: lstatConIdentita(mappa) });

  conUid(UID_SISTEMA, () => conPiattaforma('android', () => {
    host.assicuraDirDurevole(impl, foglia);
  }));

  assert.equal(fs.lstatSync(anchor).mode & 0o777, 0o700, 'the anchor is unchanged');
  assert.equal(fs.lstatSync(foglia).mode & 0o777, 0o700, 'the new ring is private');
  assert.deepEqual(mutanti, [], 'nothing is tightened');
});

// The root user is a current owner too: its own 0700 ring is the anchor, and the
// rings below it are qualified as private.
test('for the root user an own 0700 ring is the anchor and a 0775 ring below it is accepted', (t) => {
  const root = creaRadice(t);
  const condiviso = path.join(root, 'condiviso');
  fs.mkdirSync(condiviso, { mode: 0o700 });
  fs.chmodSync(condiviso, 0o775);
  const mappa = {
    ...sopraRadice(root),
    [root]: { uid: 0, mode: 0o40700 },
    [condiviso]: { uid: 0, mode: 0o40775 },
    [path.join(condiviso, 'z')]: { uid: 0 },
  };
  const { impl, mutanti } = spia({ lstatSync: lstatConIdentita(mappa) });

  conUid(0, () => host.assicuraDirDurevole(impl, path.join(condiviso, 'z')));

  assert.equal(fs.lstatSync(path.join(condiviso, 'z')).mode & 0o777, 0o700, 'the new ring is private');
  assert.equal(fs.lstatSync(condiviso).mode & 0o777, 0o775, 'the accepted ring keeps its mode');
  assert.deepEqual(mutanti, [], 'no chmod');
});

test('for the root user a 0777 ring without the sticky bit before the anchor is refused', (t) => {
  const root = creaRadice(t);
  const { impl } = spia({
    lstatSync: lstatConIdentita({ ...sopraRadice(root), [root]: { uid: 0, mode: 0o40777 } }),
  });
  conUid(0, () => {
    assert.throws(
      () => host.assicuraDirDurevole(impl, path.join(root, 'a')),
      (e) => e.code === 'ESTALE',
      'a shared ring writable by others without the sticky bit is refused',
    );
  });
  assert.equal(fs.existsSync(path.join(root, 'a')), false, 'nothing was created');
});

test('for the root user a sticky shared ring is accepted and its 0700 child is the anchor', (t) => {
  const root = creaRadice(t);
  const anchor = path.join(root, 'anch');
  fs.mkdirSync(anchor, { mode: 0o700 });
  const mappa = {
    ...sopraRadice(root),
    [root]: { uid: 0, mode: 0o41777 },
    [anchor]: { uid: 0, mode: 0o40700 },
    [path.join(anchor, 'z')]: { uid: 0 },
  };
  const { impl, mutanti } = spia({ lstatSync: lstatConIdentita(mappa) });

  conUid(0, () => host.assicuraDirDurevole(impl, path.join(anchor, 'z')));

  assert.equal(fs.lstatSync(path.join(anchor, 'z')).mode & 0o777, 0o700, 'the new ring is private');
  assert.deepEqual(mutanti, [], 'no chmod');
});
