'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'skills', 'nexuscrew-agent', 'bin', 'nc-deliver');

// Lo script gemello del tool MCP nc_send_file: stessa consegna, stessa regola.
// Il test lo lancia con NEXUSCREW_FILES_ROOT/NEXUSCREW_SESSION su una tmpdir
// (nessun tocco a ~/NexusFiles) e guarda il disco + stdout + exit code.
function deliver(env, args) {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncdeliver-')); }

test('nc-deliver: file gia\' nell\'outbox della sessione -> nessuna copia, exit 0, path esistente', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'sess1', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');

  const r = await deliver({ NEXUSCREW_FILES_ROOT: root, NEXUSCREW_SESSION: 'sess1' }, [path.join(dir, 'report.md')]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(fs.readdirSync(dir).length, 1, 'zero file nuovi accanto all\'originale');
  assert.match(r.stdout, /report\.md/, 'stdout nomina il file esistente');
});

test('nc-deliver: consegna due volte di fila -> zero file nuovi', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'sess1', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');
  const env = { NEXUSCREW_FILES_ROOT: root, NEXUSCREW_SESSION: 'sess1' };
  const src = path.join(dir, 'report.md');
  await deliver(env, [src]);
  await deliver(env, [src]);
  assert.equal(fs.readdirSync(dir).length, 1, 'due consegne, un solo file');
});

test('nc-deliver: symlink verso un file dell\'outbox -> nessuna copia (realpath decide)', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'sess1', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), 'contenuto');
  const link = path.join(root, 'link-report.md');
  fs.symlinkSync(path.join(dir, 'report.md'), link);

  const r = await deliver({ NEXUSCREW_FILES_ROOT: root, NEXUSCREW_SESSION: 'sess1' }, [link]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.match(r.stdout, /report\.md/);
});

// Pinnato: il file fuori dall'outbox resta una consegna vera, copia timbrata.
test('nc-deliver: file esterno -> copia timbrata come oggi', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'sess1', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(root, 'esterno.md');
  fs.writeFileSync(src, 'x');

  const r = await deliver({ NEXUSCREW_FILES_ROOT: root, NEXUSCREW_SESSION: 'sess1' }, [src]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.notEqual(files[0], 'esterno.md', 'nome timbrato');
  assert.match(files[0], /_esterno\.md$/);
  assert.match(r.stdout, /delivered/);
});
