'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { filesRoutes } = require('../lib/files/routes.js');
const store = require('../lib/files/store.js');

function setup(t, { maxUpload = 1024 * 1024, readonly = false, pasteOk = true, root: customRoot } = {}) {
  const root = customRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'ncroutes-'));
  const pasted = [];
  const notified = [];
  const app = express();
  app.use('/api/files', filesRoutes({
    cfg: { filesRoot: root, home: root, maxUpload },
    sessionExists: (s) => s === 'sess1',
    paste: (s, text) => { pasted.push([s, text]); return pasteOk; },
    notifier: {
      emit: (frame) => {
        notified.push(frame);
        return Promise.resolve({ ui: 0, push: 0 });
      },
    },
    readonly: () => readonly,
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({
        root, pasted, notified, base: `http://127.0.0.1:${srv.address().port}/api/files`,
      });
    });
  });
}

test('outbox bridge labels its fixed Italian service text explicitly', async (t) => {
  const { root, notified, base } = await setup(t);
  const src = path.join(root, 'report.txt');
  fs.writeFileSync(src, 'report');
  const r = await fetch(`${base}/outbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'sess1', path: src, caption: 'riepilogo' }),
  });
  assert.equal(r.status, 200);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].lang, 'it');
  assert.match(notified[0].title, /file da sess1/);
});

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
  // R31-A2 (a): il paste NON richiesto resta un esito legittimo — 200 SENZA
  // error. Se un domani questo ramo diventasse un fallimento, il tasto
  // allegati del composer segnalerebbe guasti inesistenti.
  assert.equal(j.error, undefined, 'paste non richiesto non e\' un errore');
});

// R31-A2 (b): paste RICHIESTO e fallito (tmux non ha ricevuto). Prima del fix
// questo era 200 {pasted:false} — indistinguibile dal paste mai richiesto e
// dal testo respinto: tre cause collassate in una sola etichetta muta.
// Il vocabolario e' quello del ramo answer degli ask (lib/notify/routes.js):
// «paste fallito» si dice 502 + error, con la sessione nel messaggio.
test('upload: paste richiesto e fallito -> 502 con la causa, il file resta salvato', async (t) => {
  const { root, pasted, base } = await setup(t, { pasteOk: false });
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('doc.txt', 'ciao') });
  assert.equal(r.status, 502, 'la mancata consegna alla cella non e\' un 200 OK');
  const j = await r.json();
  assert.equal(j.error, 'paste fallito: sessione "sess1" non raggiungibile');
  // La causa vera detta cosa e' successo e cosa no: il file E' in inbox
  // (scaricabile), la PTY non l'ha ricevuto.
  assert.ok(j.name.endsWith('_doc.txt'), 'il file salvato resta nella risposta');
  assert.equal(fs.readFileSync(j.path, 'utf8'), 'ciao');
  assert.equal(j.pasted, false);
  assert.equal(pasted.length, 1, 'la PTY e\' stata tentata (e ha detto no)');
});

// R31-A2 (c): testo respinto a monte (pasteArgs null). Il nome upload e'
// sanitizzato (niente control char): la causa viva e' il filesRoot di
// configurazione. Il rifiuto e' noto PRIMA di tmux: la PTY non va neanche
// tentata. Prima del fix: 200 con pasted:false e una PTY chiamata per un
// testo che pasteToSession avrebbe rifiutato comunque.
test('upload: path non incollabile -> 502 SENZA tentare la PTY', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ncroutes-'));
  const root = path.join(outer, 'cfg\x01root'); // control char nel path di configurazione
  fs.mkdirSync(root, { recursive: true });
  t.after(() => { fs.rmSync(outer, { recursive: true, force: true }); });
  const { pasted, base } = await setup(t, { root });
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('doc.txt', 'ciao') });
  // 500, non 502 (rilievo audit su d6c47c6): qui tmux NON e' stato mai
  // contattato — a rifiutare siamo noi, per configurazione nostra. 502
  // affermerebbe «il servizio a monte non risponde»: falso, e sveglierebbe un
  // allarme su un tmux che sta benissimo. La coppia di codici e' informazione:
  // 502 = raggiunto ma non ha preso (b); 500 = mai tentato, colpa nostra (c).
  assert.equal(r.status, 500, 'il rifiuto a monte e\' colpa nostra, non del valle: 500');
  const j = await r.json();
  assert.match(j.error, /paste fallito: path non incollabile/, JSON.stringify(j));
  assert.ok(j.name.endsWith('_doc.txt'), 'il file salvato resta nella risposta');
  assert.equal(j.pasted, false);
  assert.equal(pasted.length, 0, 'il rifiuto e\' a monte: nessuna scrittura PTY tentata');
});

test('upload: oltre il limite -> 413', async (t) => {
  const { base } = await setup(t, { maxUpload: 10 });
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('big.bin', 'x'.repeat(100)) });
  assert.equal(r.status, 413);
});

test('READONLY blocks upload and delete at the destination route', async (t) => {
  const { root, base } = await setup(t, { readonly: true });
  assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: form('x.txt', 'x') })).status, 403);
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  assert.equal((await fetch(`${base}/?session=sess1&box=outbox&name=keep.txt`, { method: 'DELETE' })).status, 403);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
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
