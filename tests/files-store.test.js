'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/files/store.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncfiles-')); }

test('sanitizeName: basename, control char, mai vuoto', () => {
  assert.equal(store.sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(store.sanitizeName('a b\nc.txt'), 'a_bc.txt');
  assert.equal(store.sanitizeName('..'), 'file');
  assert.equal(store.sanitizeName(''), 'file');
  assert.ok(store.sanitizeName('x'.repeat(300)).length <= 128);
});

test('isValidSession: regex tmux', () => {
  assert.ok(store.isValidSession('worker_session'));
  assert.ok(store.isValidSession('Worker-VL_DS4P'));
  assert.ok(!store.isValidSession('../evil'));
  assert.ok(!store.isValidSession(''));
  assert.ok(!store.isValidSession('a/b'));
});

test('saveUpload: timbro, no overwrite, contenuto', () => {
  const root = tmpRoot();
  const now = new Date(2026, 6, 6, 14, 32);
  const a = store.saveUpload(root, 'sess1', Buffer.from('ciao'), 'foto.jpg', now);
  assert.equal(a.name, '20260706-1432_foto.jpg');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'ciao');
  const b = store.saveUpload(root, 'sess1', Buffer.from('bis'), 'foto.jpg', now);
  assert.notEqual(b.name, a.name);
  assert.equal(store.saveUpload(root, '../evil', Buffer.from('x'), 'f'), null);
});

test('listBox: ordina mtime desc, ENOENT=[], invalidi=null', () => {
  const root = tmpRoot();
  assert.deepEqual(store.listBox(root, 'sess1', 'outbox'), []);
  assert.equal(store.listBox(root, 'sess1', 'trash'), null);
  assert.equal(store.listBox(root, '../evil', 'inbox'), null);
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'a');
  fs.utimesSync(path.join(dir, 'old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'b');
  const list = store.listBox(root, 'sess1', 'outbox');
  assert.equal(list[0].name, 'new.txt');
  assert.equal(list.length, 2);
});

test('resolveExisting/removeFile: traversal bloccato', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
  fs.writeFileSync(path.join(root, 'sess1', 'secret.txt'), 'no');
  assert.ok(store.resolveExisting(root, 'sess1', 'outbox', 'ok.txt'));
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', '../secret.txt'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', '..'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', 'a/b.txt'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', 'manca.txt'), null);
  assert.ok(store.removeFile(root, 'sess1', 'outbox', 'ok.txt'));
  assert.ok(!fs.existsSync(path.join(dir, 'ok.txt')));
  assert.ok(!store.removeFile(root, 'sess1', 'outbox', '../secret.txt'));
});

test('resolveExisting: rifiuta symlink che punta fuori dalla box (anti-evasion)', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  // file reale FUORI dalla box (ma dentro la dir sessione)
  const outside = path.join(root, 'sess1', 'secret2.txt');
  fs.writeFileSync(outside, 'premiato');
  // symlink dentro la outbox che punta al file esterno
  fs.symlinkSync(outside, path.join(dir, 'link.txt'));
  // un file regolare continuo a risolvere
  fs.writeFileSync(path.join(dir, 'real.txt'), 'ok');
  assert.ok(store.resolveExisting(root, 'sess1', 'outbox', 'real.txt'));
  // il symlink NON deve essere servito (lstat, non stat): evasione bloccata
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', 'link.txt'), null);
});
