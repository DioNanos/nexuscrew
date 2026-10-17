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

// Sorgente già nell'outbox di DESTINAZIONE (il flusso documentato: la cella
// scrive il file nella propria outbox e lo consegna con nc_send_file): la
// consegna è idempotente — nessuna copia timbrata accanto all'originale, il
// file esistente È la consegna («ogni invio è doppio in lista»).
test('saveDeliverable: sorgente già nell\'outbox di destinazione -> nessuna copia, already', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');
  const saved = store.saveDeliverable(root, 'sess1', path.join(dir, 'report.md'), new Date(2026, 9, 16, 13, 17));
  assert.equal(fs.readdirSync(dir).length, 1, 'nessun secondo file accanto all\'originale');
  assert.equal(saved.name, 'report.md', 'il nome è quello reale, senza timbro');
  assert.equal(saved.path, path.join(dir, 'report.md'));
  assert.equal(saved.size, 'contenuto'.length);
  assert.equal(saved.already, true);
});

// La stessa consegna due volte di fila: zero file nuovi anche la seconda.
test('saveDeliverable: stessa consegna due volte di fila -> zero file nuovi', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');
  const src = path.join(dir, 'report.md');
  const first = store.saveDeliverable(root, 'sess1', src, new Date(2026, 9, 16, 13, 17));
  const second = store.saveDeliverable(root, 'sess1', src, new Date(2026, 9, 16, 13, 18));
  assert.equal(first.already, true);
  assert.equal(second.already, true);
  assert.equal(fs.readdirSync(dir).length, 1, 'due consegne, un solo file');
});

// Il sorgente è un SYMLINK che rientra nell'outbox di destinazione: decide il
// realpath — è lo stesso file, nessuna copia.
test('saveDeliverable: sorgente symlink verso un file dell\'outbox -> already (realpath decide)', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');
  const link = path.join(root, 'link-report.md');
  fs.symlinkSync(path.join(dir, 'report.md'), link);
  const saved = store.saveDeliverable(root, 'sess1', link, new Date(2026, 9, 16, 13, 17));
  assert.equal(saved.already, true);
  assert.equal(saved.name, 'report.md', 'il nome del file reale, non del link');
  assert.equal(saved.path, path.join(dir, 'report.md'));
  assert.equal(fs.readdirSync(dir).length, 1);
});

// Pinnato: l'outbox di UN'ALTRA sessione non è la destinazione — la copia
// timbrata resta (il fix non stringe troppo). E rispedire la copia consegnata
// non fa più nascere il doppio prefisso.
test('saveDeliverable: sorgente nell\'outbox di un\'altra sessione -> copia timbrata come oggi', () => {
  const root = tmpRoot();
  const srcDir = store.ensureBox(root, 'sess2', 'outbox');
  fs.writeFileSync(path.join(srcDir, 'report.md'), 'altro');
  const saved = store.saveDeliverable(root, 'sess1', path.join(srcDir, 'report.md'), new Date(2026, 9, 16, 13, 17));
  assert.equal(saved.name, '20261016-1317_report.md');
  assert.equal(saved.already, undefined, 'la copia vera non è already');
  assert.equal(fs.readdirSync(srcDir).length, 1, 'il sorgente resta al suo posto');
  const dstDir = store.boxDir(root, 'sess1', 'outbox');
  assert.equal(fs.readdirSync(dstDir).length, 1, 'una sola copia in sess1');
  // rispedire la copia appena consegnata: è già nell'outbox di sess1
  const again = store.saveDeliverable(root, 'sess1', saved.path, new Date(2026, 9, 16, 13, 18));
  assert.equal(again.already, true);
  assert.equal(again.name, saved.name, 'niente doppio prefisso');
  assert.equal(fs.readdirSync(dstDir).length, 1);
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
