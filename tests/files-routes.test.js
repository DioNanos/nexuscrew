'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { filesRoutes } = require('../lib/files/routes.js');
const store = require('../lib/files/store.js');

function setup(t, { maxUpload = 1024 * 1024 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncroutes-'));
  const pasted = [];
  const app = express();
  app.use('/api/files', filesRoutes({
    cfg: { filesRoot: root, maxUpload },
    sessionExists: (s) => s === 'sess1',
    paste: (s, text) => { pasted.push([s, text]); return true; },
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({ root, pasted, base: `http://127.0.0.1:${srv.address().port}/api/files` });
    });
  });
}

function form(name, content) {
  const fd = new FormData();
  fd.append('session', 'sess1');
  fd.append('file', new Blob([content]), name);
  return fd;
}

test('upload: salva in inbox, incolla il path, 404 per sessione ignota', async (t) => {
  const { root, pasted, base } = await setup(t);
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('doc.txt', 'ciao') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.name.endsWith('_doc.txt'));
  assert.equal(fs.readFileSync(j.path, 'utf8'), 'ciao');
  assert.equal(j.pasted, true);
  assert.deepEqual(pasted[0], ['sess1', j.path]);

  const fd = form('doc.txt', 'x');
  fd.set('session', 'ghost');
  assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: fd })).status, 404);
});

// paste=false (tasto allegati del composer): il file va in inbox ma il path
// NON viene incollato nel PTY — lo appende il client al testo del composer.
// Default (campo assente) = comportamento storico, testato sopra.
test('upload: paste=false salva in inbox SENZA incollare nel PTY', async (t) => {
  const { pasted, base } = await setup(t);
  const fd = form('shot.png', 'img');
  fd.append('paste', 'false');
  const r = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.name.endsWith('_shot.png'));
  assert.equal(fs.readFileSync(j.path, 'utf8'), 'img');
  assert.equal(j.pasted, false, 'pasted deve essere false');
  assert.equal(pasted.length, 0, 'nessuna scrittura PTY con paste=false');
});

test('upload: oltre il limite -> 413', async (t) => {
  const { base } = await setup(t, { maxUpload: 10 });
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('big.bin', 'x'.repeat(100)) });
  assert.equal(r.status, 413);
});

test('list/download/delete con guardie', async (t) => {
  const { root, base } = await setup(t);
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'out.txt'), 'deliverable');

  const list = await (await fetch(`${base}/?session=sess1`)).json();
  assert.equal(list.outbox[0].name, 'out.txt');
  assert.deepEqual(list.inbox, []);
  assert.equal((await fetch(`${base}/?session=../evil`)).status, 400);

  const dl = await fetch(`${base}/download?session=sess1&box=outbox&name=out.txt`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'deliverable');
  assert.equal((await fetch(`${base}/download?session=sess1&box=outbox&name=../secret`)).status, 404);

  assert.equal((await fetch(`${base}/?session=sess1&box=outbox&name=out.txt`, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'out.txt')));
  assert.equal((await fetch(`${base}/?session=sess1&box=outbox&name=out.txt`, { method: 'DELETE' })).status, 404);
});
