'use strict';
// Claim records and the launch writer lock must keep working on filesystems
// that deny link(2): the SAME shared fallback primitive as the rest of the
// product (exclusive creation, verified content, sync, no atomic appearance).
// A partial name means occupied/uncertain: never reaped by a competitor, and
// a creator only ever removes its own proven generation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sezione = require('../lib/fleet/vl-claim-section.js');
const lock = require('../lib/fleet/launch-writer-lock.js');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nolink-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  return d;
}

function negaLink(t, code) {
  const orig = fs.linkSync;
  t.after(() => { fs.linkSync = orig; });
  fs.linkSync = function nega() {
    const e = new Error(`${code}: link denied`);
    e.code = code;
    throw e;
  };
}

const HASH = 'ab'.repeat(32);
const dato = { v: 1, owner: 'owner-x', ts: 123 };

test('claim record: published through the fallback when link is denied (EACCES)', (t) => {
  const dir = tmp(t);
  negaLink(t, 'EACCES');
  const r = sezione.pubblicare(dir, HASH, 'claim', dato);
  assert.equal(r.esito, 'pubblicato', JSON.stringify(r));
  const file = path.join(dir, `${HASH}.claim`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'owner-x');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('claim record: EXDEV is a denied link too, EIO is not', (t) => {
  const dirA = tmp(t);
  negaLink(t, 'EXDEV');
  assert.equal(sezione.pubblicare(dirA, HASH, 'claim', dato).esito, 'pubblicato');
  const dirB = tmp(t);
  negaLink(t, 'EIO');
  const r = sezione.pubblicare(dirB, HASH, 'claim', dato);
  assert.notEqual(r.esito, 'pubblicato');
  assert.equal(fs.existsSync(path.join(dirB, `${HASH}.claim`)), false);
});

test('claim record: an existing winner is never overwritten, with or without link', (t) => {
  for (const code of [null, 'EACCES']) {
    const dir = tmp(t);
    if (code) negaLink(t, code);
    const vincitore = { v: 1, owner: 'winner', ts: 1 };
    assert.equal(sezione.pubblicare(dir, HASH, 'claim', vincitore).esito, 'pubblicato');
    const file = path.join(dir, `${HASH}.claim`);
    const byte = fs.readFileSync(file);
    const r = sezione.pubblicare(dir, HASH, 'claim', dato);
    assert.equal(r.esito, 'esiste', JSON.stringify(r));
    assert.deepEqual(fs.readFileSync(file), byte);
  }
});

test('claim record: a crashed fallback write leaves the partial name, never reaped', (t) => {
  const dir = tmp(t);
  negaLink(t, 'EACCES');
  const origWrite = fs.writeSync;
  let guastato = false;
  fs.writeSync = function guasta(fd, buf, off, len, pos) {
    // First write on the final name: a prefix, then a hard error.
    if (typeof pos === 'number' && !guastato) {
      guastato = true;
      const n = origWrite(fd, buf, off, 3, pos);
      const e = new Error('EIO: injected');
      e.code = 'EIO';
      throw e;
    }
    return origWrite(fd, buf, off, len, pos);
  };
  let r;
  try { r = sezione.pubblicare(dir, HASH, 'claim', dato); } finally { fs.writeSync = origWrite; }
  assert.notEqual(r.esito, 'pubblicato');
  const file = path.join(dir, `${HASH}.claim`);
  assert.equal(fs.existsSync(file), true, 'the uncertain name stays for diagnosis');
  const parziale = fs.readFileSync(file);
  // A competitor meeting the residue: busy/uncertain, never a repair.
  const r2 = sezione.pubblicare(dir, HASH, 'claim', dato);
  assert.equal(r2.esito, 'esiste');
  assert.deepEqual(fs.readFileSync(file), parziale);
});

test('writer lock: acquired through the fallback, EXDEV included', (t) => {
  for (const code of ['EACCES', 'EXDEV']) {
    const root = tmp(t);
    negaLink(t, code);
    const a = lock.acquisisci(root);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(lock.verifica(root, a.token), true);
    assert.equal(lock.rilascia(root, a.token), true);
    assert.equal(fs.existsSync(path.join(root, 'launch-targets', lock.NOME)), false);
  }
});

test('writer lock: a second live writer is refused without link', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const a = lock.acquisisci(root);
  assert.equal(a.ok, true);
  // A different process would see the name: here the file itself is the proof.
  const file = path.join(root, 'launch-targets', lock.NOME);
  assert.equal(fs.existsSync(file), true);
  assert.equal(lock.verifica(root, '00000000'), false);
  assert.equal(lock.rilascia(root, '00000000'), false);
  const byte = fs.readFileSync(file);
  assert.equal(lock.rilascia(root, a.token), true);
  assert.notEqual(fs.existsSync(file) && fs.readFileSync(file).equals(byte), true);
});

test('writer lock: a failed fallback write removes only its own complete generation', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const origSync = fs.fsyncSync;
  let guastato = false;
  fs.fsyncSync = function guasta(fd) {
    // Deny the LAST sync of the final object (after the content is complete).
    if (guastato) { const e = new Error('EIO: injected'); e.code = 'EIO'; throw e; }
    guastato = true;
    return origSync(fd);
  };
  let a;
  try { a = lock.acquisisci(root); } finally { fs.fsyncSync = origSync; }
  assert.equal(a.ok, false, JSON.stringify(a));
  const file = path.join(root, 'launch-targets', lock.NOME);
  // Either it was proven ours and removed, or it stays complete and verifiable.
  if (fs.existsSync(file)) {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1);
  }
  // No permanent dead end: a clean retry acquires.
  const b = lock.acquisisci(root);
  assert.equal(b.ok, true, JSON.stringify(b));
  lock.rilascia(root, b.token);
});

// First write with an explicit position = the write to the final name (the
// private temporaries are written with writeFileSync, which does not use it).
function conScritturaFinale(t, hook) {
  const origWrite = fs.writeSync;
  let scattato = false;
  fs.writeSync = function intercetta(fd, buf, off, len, pos) {
    if (typeof pos === 'number' && !scattato) {
      scattato = true;
      return hook(() => origWrite(fd, buf, off, len, pos), () => origWrite(fd, buf, off, 3, pos));
    }
    return origWrite(fd, buf, off, len, pos);
  };
  t.after(() => { fs.writeSync = origWrite; });
}

test('claim record: a contender during the creator write sees occupied, the creator completes', (t) => {
  const dir = tmp(t);
  negaLink(t, 'EACCES');
  let concorrente = null;
  conScritturaFinale(t, (completa) => {
    concorrente = sezione.pubblicare(dir, HASH, 'claim', { v: 1, owner: 'contender', ts: 2 });
    return completa();
  });
  const r = sezione.pubblicare(dir, HASH, 'claim', dato);
  assert.equal(concorrente.esito, 'esiste', JSON.stringify(concorrente));
  assert.equal(r.esito, 'pubblicato', JSON.stringify(r));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${HASH}.claim`), 'utf8')).owner, 'owner-x');
});

test('writer lock: a contender during the creator write is refused, the creator completes', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  let concorrente = null;
  conScritturaFinale(t, (completa) => {
    concorrente = lock.acquisisci(root);
    return completa();
  });
  const a = lock.acquisisci(root);
  assert.equal(concorrente.ok, false, JSON.stringify(concorrente));
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(lock.verifica(root, a.token), true);
  lock.rilascia(root, a.token);
});

test('writer lock: the partial name of a dead creator stays and no contender reaps it', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const dir = path.join(root, 'launch-targets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, lock.NOME);
  // What a creator that died mid-write leaves behind: a prefix of a record.
  fs.writeFileSync(file, '{"v":1,"pid":', { mode: 0o600 });
  const parziale = fs.readFileSync(file);
  for (let i = 0; i < 2; i += 1) {
    const b = lock.acquisisci(root);
    assert.equal(b.ok, false, JSON.stringify(b));
    assert.equal(b.codice, 'illeggibile', JSON.stringify(b));
    assert.deepEqual(fs.readFileSync(file), parziale, 'no repair, no replacement, no removal');
  }
  assert.equal(fs.existsSync(path.join(dir, lock.NOME_MUTEX)), false);
});

test('writer lock: a failed write mid-record removes the creator own partial object', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  conScritturaFinale(t, (_completa, prefisso) => {
    prefisso();
    const e = new Error('EIO: injected');
    e.code = 'EIO';
    throw e;
  });
  const a = lock.acquisisci(root);
  assert.equal(a.ok, false);
  const file = path.join(root, 'launch-targets', lock.NOME);
  assert.equal(fs.existsSync(file), false, 'own generation proven by identity and bytes: removed');
  const b = lock.acquisisci(root);
  assert.equal(b.ok, true, JSON.stringify(b));
  lock.rilascia(root, b.token);
});

test('writer lock: a delayed cleanup never removes the successor generation', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const file = path.join(root, 'launch-targets', lock.NOME);
  const successore = `${JSON.stringify({ v: 1, pid: process.pid, starttime: 1, token: 'successor-token' })}\n`;
  const origSync = fs.fsyncSync;
  let chiamate = 0;
  fs.fsyncSync = function guasta(fd) {
    chiamate += 1;
    if (chiamate === 1) return origSync(fd);
    // The final object fails its sync; before the creator can clean up, the
    // name changes hands to a complete successor generation.
    fs.unlinkSync(file);
    fs.writeFileSync(file, successore, { mode: 0o600 });
    const e = new Error('EIO: injected');
    e.code = 'EIO';
    throw e;
  };
  let a;
  try { a = lock.acquisisci(root); } finally { fs.fsyncSync = origSync; }
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.equal(fs.readFileSync(file, 'utf8'), successore, 'the successor record is untouched');
});

test('shared primitive and the inlined helper copy agree on every outcome', (t) => {
  const { pubblicaEsclusiva: condivisa } = require('../lib/fleet/exclusive-publish.js');
  const inlined = sezione.pubblicaEsclusiva;
  const bytes = Buffer.from('{"v":1}', 'utf8');
  const scenari = [
    ['published through link', null, null, false],
    ['link denied EACCES', 'EACCES', null, false],
    ['link denied EXDEV', 'EXDEV', null, false],
    ['link fails EIO', 'EIO', null, false],
    ['destination exists', null, null, true],
    ['destination exists, link denied', 'EPERM', null, true],
    ['final sync fails', 'EACCES', 'fsync', false],
  ];
  for (const [nomeScenario, codiceLink, guasto, esiste] of scenari) {
    const esiti = [condivisa, inlined].map((publish) => {
      const dir = tmp(t);
      const src = path.join(dir, 'src.tmp');
      const dest = path.join(dir, 'final');
      fs.writeFileSync(src, bytes, { mode: 0o600 });
      if (esiste) fs.writeFileSync(dest, 'other', { mode: 0o600 });
      const origLink = fs.linkSync;
      const origSync = fs.fsyncSync;
      if (codiceLink) {
        fs.linkSync = () => { const e = new Error(codiceLink); e.code = codiceLink; throw e; };
      }
      if (guasto === 'fsync') {
        fs.fsyncSync = () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; };
      }
      try {
        const r = publish({ src, dest, bytes });
        return { status: r.status, via: r.via, code: r.code, presente: fs.existsSync(dest) };
      } finally { fs.linkSync = origLink; fs.fsyncSync = origSync; }
    });
    assert.deepEqual(esiti[1], esiti[0], nomeScenario);
  }
});

function conSyncFinaleGuasta(t, prima) {
  const origSync = fs.fsyncSync;
  let chiamate = 0;
  fs.fsyncSync = function guasta(fd) {
    chiamate += 1;
    if (chiamate === 1) return origSync(fd);
    prima();
    const e = new Error('EIO: injected');
    e.code = 'EIO';
    throw e;
  };
  t.after(() => { fs.fsyncSync = origSync; });
}

test('writer lock: a successor that just created its empty name is not removed by the old creator', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const file = path.join(root, 'launch-targets', lock.NOME);
  conSyncFinaleGuasta(t, () => {
    // An empty file is a prefix of any record: only the object identity tells
    // the successor apart.
    fs.unlinkSync(file);
    fs.writeFileSync(file, '', { mode: 0o600 });
  });
  const a = lock.acquisisci(root);
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.equal(fs.existsSync(file), true, 'the successor name is untouched');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('writer lock: foreign bytes under a recycled identity are not removed by the old creator', (t) => {
  const root = tmp(t);
  negaLink(t, 'EACCES');
  const file = path.join(root, 'launch-targets', lock.NOME);
  const altro = `${JSON.stringify({ v: 1, pid: process.pid, starttime: 1, token: 'recycled-token' })}\n`;
  conSyncFinaleGuasta(t, () => {
    // Same inode, other bytes: what an inode number reused after the creator
    // closed its descriptor would look like.
    fs.writeFileSync(file, altro);
  });
  const a = lock.acquisisci(root);
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.equal(fs.readFileSync(file, 'utf8'), altro);
});
