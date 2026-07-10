'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { fsRoutes } = require('../lib/fs/routes.js');

// App minimale: solo il router /fs con una home sandbox temporanea.
function boot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfs-'));
  fs.mkdirSync(path.join(home, 'Dev'));
  fs.mkdirSync(path.join(home, 'Dev', 'proj'));
  fs.mkdirSync(path.join(home, '.hidden'));
  fs.writeFileSync(path.join(home, 'file.txt'), 'x');
  fs.symlinkSync(path.join(home, 'Dev'), path.join(home, 'link-dir'));       // symlink → dir interna
  fs.symlinkSync('/etc', path.join(home, 'link-out'));                       // symlink → FUORI dalla home
  fs.symlinkSync(path.join(home, 'missing'), path.join(home, 'link-broken')); // symlink rotto
  const app = express();
  app.use('/fs', fsRoutes({ home }));
  const server = app.listen(0, '127.0.0.1');
  return new Promise((res) => server.on('listening', () => {
    t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, home: fs.realpathSync(home) });
  }));
}

test('dirs: lista solo directory, hidden esclusi di default, symlink-dir inclusi', async (t) => {
  const { base, home } = await boot(t);
  const r = await fetch(`${base}/fs/dirs`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.path, home);
  assert.equal(j.parent, null, 'alla root della home parent è null');
  assert.deepEqual(j.dirs, ['Dev', 'link-dir', 'link-out'], 'no file, no hidden, no symlink rotti');
  // hidden=1 li mostra
  const h = await (await fetch(`${base}/fs/dirs?hidden=1`)).json();
  assert.ok(h.dirs.includes('.hidden'));
});

test('dirs: naviga in sottocartella, parent valorizzato', async (t) => {
  const { base, home } = await boot(t);
  const j = await (await fetch(`${base}/fs/dirs?path=${encodeURIComponent(path.join(home, 'Dev'))}`)).json();
  assert.equal(j.path, path.join(home, 'Dev'));
  assert.equal(j.parent, home);
  assert.deepEqual(j.dirs, ['proj']);
});

test('dirs: confinamento — traversal e symlink-escape 403, inesistente 404, file 404', async (t) => {
  const { base, home } = await boot(t);
  assert.equal((await fetch(`${base}/fs/dirs?path=${encodeURIComponent('/etc')}`)).status, 403);
  assert.equal((await fetch(`${base}/fs/dirs?path=${encodeURIComponent(path.join(home, '..'))}`)).status, 403);
  assert.equal((await fetch(`${base}/fs/dirs?path=${encodeURIComponent(path.join(home, 'link-out'))}`)).status, 403, 'symlink verso fuori: bloccato');
  assert.equal((await fetch(`${base}/fs/dirs?path=${encodeURIComponent(path.join(home, 'nope'))}`)).status, 404);
  assert.equal((await fetch(`${base}/fs/dirs?path=${encodeURIComponent(path.join(home, 'file.txt'))}`)).status, 404, 'un file non è sfogliabile');
});

test('dirs: dietro Bearer quando montato sotto /api (integrazione server)', async (t) => {
  // Il router in sé non ha auth: verifica che nel server VERO stia sotto requireToken.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  const apiUse = src.indexOf("api.use('/fs'");
  const tokenUse = src.indexOf('api.use(requireToken');
  assert.ok(apiUse > tokenUse && tokenUse !== -1, "api.use('/fs') deve stare DOPO requireToken");
});
