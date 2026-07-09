const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateToken, verify, readTokenSafe } = require('../lib/auth/token.js');

test('loadOrCreateToken creates a 0600 file and is stable', () => {
  const p = path.join(os.tmpdir(), 'nc_tok_' + process.pid);
  fs.rmSync(p, { force: true });
  const t1 = loadOrCreateToken(p);
  assert.ok(t1 && t1.length >= 24);
  const mode = fs.statSync(p).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  const t2 = loadOrCreateToken(p);
  assert.strictEqual(t1, t2);
  fs.rmSync(p, { force: true });
});

test('loadOrCreateToken preserves existing non-empty token (no overwrite)', () => {
  const p = path.join(os.tmpdir(), 'nc_tok_preserve_' + process.pid);
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, 'PRE_EXISTING_TOKEN\n', { mode: 0o600 });
  const t = loadOrCreateToken(p);
  assert.equal(t, 'PRE_EXISTING_TOKEN');
  // contenuto invariato
  assert.equal(fs.readFileSync(p, 'utf8').trim(), 'PRE_EXISTING_TOKEN');
  fs.rmSync(p, { force: true });
});

test('loadOrCreateToken rejects symlink token path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-symlink-'));
  const real = path.join(dir, 'real');
  fs.writeFileSync(real, 'x\n', { mode: 0o600 });
  const link = path.join(dir, 'link');
  try {
    fs.symlinkSync(real, link);
  } catch (_) {
    fs.rmSync(dir, { recursive: true, force: true });
    return; // skip se symlink non supportato (es. permessi)
  }
  assert.throws(() => loadOrCreateToken(link), /symlink/i);
  // il symlink non e' stato seguito (real intatto)
  assert.equal(fs.readFileSync(real, 'utf8').trim(), 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadOrCreateToken recreates empty token file (exclusive)', () => {
  const p = path.join(os.tmpdir(), 'nc_tok_empty_' + process.pid);
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, '', { mode: 0o600 }); // file vuoto
  const t = loadOrCreateToken(p);
  assert.ok(t && t.length >= 24); // ne crea uno nuovo
  assert.notEqual(t, '');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.rmSync(p, { force: true });
});

test('loadOrCreateToken concurrent-safe: pre-existing file returns same token (EEXIST path)', () => {
  // simula un altro processo che ha creato il file prima della nostra wx
  const p = path.join(os.tmpdir(), 'nc_tok_race_' + process.pid);
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, 'RACE_TOKEN\n', { mode: 0o600 });
  const t = loadOrCreateToken(p);
  assert.equal(t, 'RACE_TOKEN'); // ritorna il token esistente, no crash, no overwrite
  fs.rmSync(p, { force: true });
});

test('readTokenSafe: regular file -> content (M2 race-safe read)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rsf-'));
  const p = path.join(dir, 'token');
  fs.writeFileSync(p, 'TOKEN_X\n', { mode: 0o600 });
  assert.equal(readTokenSafe(p), 'TOKEN_X');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTokenSafe: reject symlink (M2 race-safe, no follow)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rs-'));
  const real = path.join(dir, 'real');
  fs.writeFileSync(real, 'secret\n', { mode: 0o600 });
  const link = path.join(dir, 'link');
  try { fs.symlinkSync(real, link); } catch (_) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  assert.throws(() => readTokenSafe(link), /symlink/i); // non segue il symlink
  assert.equal(fs.readFileSync(real, 'utf8').trim(), 'secret'); // real intatto
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify is constant-time-ish and correct', () => {
  assert.strictEqual(verify('abc', 'abc'), true);
  assert.strictEqual(verify('abc', 'abd'), false);
  assert.strictEqual(verify('abc', 'abcd'), false);
  assert.strictEqual(verify('', 'x'), false);
});
