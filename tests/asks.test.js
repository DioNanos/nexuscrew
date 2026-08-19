'use strict';
// MCP bridge — asks (lib/notify/asks.js + routes). Router standalone con deps
// iniettate: paste MOCKATO (mai tmux reale), hub/push finti che catturano i
// frame. La persistenza usa SOLO os.tmpdir().
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createNotifier } = require('../lib/notify/notifier.js');
const { notifyRoutes, sanitizePasteText } = require('../lib/notify/routes.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncasks-')); }

function setup(t, { readonly = false, pasteOk = true, pasteImpl, askRate, replyLabel } = {}) {
  const dir = tmpdir();
  const frames = [];
  const hub = { broadcast: (f) => { frames.push(f); return 1; }, clientCount: () => 1 };
  const push = { sendToAll: async () => ({ sent: 0, removed: 0 }) };
  const pasted = [];
  // pasteState.ok e' commutabile a runtime (test retry dopo paste fallito)
  const pasteState = { ok: pasteOk };
  const paste = pasteImpl || ((session, text) => { pasted.push([session, text]); return Promise.resolve(pasteState.ok); });
  const asks = createAsksStore({ dir });
  const app = express();
  app.use('/api', notifyRoutes({
    cfg: { readonlyDefault: readonly, replyLabel, ...(askRate ? { askRate } : {}) },
    notifier: createNotifier({ hub, push }),
    push,
    asks,
    paste,
    sessionExists: (s) => typeof s === 'string' && s.startsWith('cell-'),
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({
        dir, frames, pasted, asks, pasteState,
        j: (p, opts = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
          ...opts,
          headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        }),
      });
    });
  });
}

test('create ask: 201 + persistenza 0600 + frame ask e notify high', async (t) => {
  const { j, dir, frames } = await setup(t);
  const r = await j('/api/asks', {
    method: 'POST',
    body: JSON.stringify({ question: 'merge o aspetto?', options: ['merge', 'aspetta'], session: 'cell-a' }),
  });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.match(id, /^[0-9a-f]{8}$/);

  const file = path.join(dir, 'asks.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).asks[0].id, id);

  const askFrame = frames.find((f) => f.type === 'ask');
  assert.equal(askFrame.ask.id, id);
  const ntf = frames.find((f) => f.type === 'notify');
  assert.equal(ntf.urgency, 'high');
  assert.equal(ntf.lang, 'it');
  assert.match(ntf.title, /cell-a/);

  const open = await (await j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 1);
  assert.equal(open.asks[0].question, 'merge o aspetto?');
});

test('create ask: validazione fail-closed (sessione, question, options)', async (t) => {
  const { j } = await setup(t);
  // sessione mancante/invalida -> 400; inesistente -> 404
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: 'x' }) })).status, 400);
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: 'x', session: '../evil' }) })).status, 400);
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: 'x', session: 'ghost' }) })).status, 404);
  // question vuota / options garbage -> 400
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: '  ', session: 'cell-a' }) })).status, 400);
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: 'x', options: [1], session: 'cell-a' }) })).status, 400);
  assert.equal((await j('/api/asks', { method: 'POST', body: JSON.stringify({ question: 'x', session: 'cell-a', extra: true }) })).status, 400);
});

test('answer: paste col prefisso neutro, answered una volta sola', async (t) => {
  const { j, pasted, frames } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'procedo?', session: 'cell-a' }),
  })).json();

  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'vai pure' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { answered: true, id });
  assert.deepEqual(pasted, [['cell-a', `[human reply · ask#${id}] vai pure`]]);
  assert.ok(frames.some((f) => f.type === 'ask-answered' && f.id === id));

  // ask answered non si ri-risponde -> 409, nessun secondo paste
  const again = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'bis' }) });
  assert.equal(again.status, 409);
  assert.equal(pasted.length, 1);

  // sparito dagli open
  const open = await (await j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 0);
});

test('answer: oltre MAX_ANSWER la risposta e RIFIUTATA, non troncata in silenzio', async (t) => {
  const { j, pasted } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'procedo?', session: 'cell-a' }),
  })).json();

  const lungo = 'x'.repeat(3901);
  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: lungo }) });
  assert.equal(r.status, 400, 'oltre il tetto si rifiuta con 400');
  const body = await r.json();
  assert.match(body.error || '', /3900/, 'l\'errore dichiara il tetto');
  assert.match(body.error || '', /3901/, 'e dichiara anche QUANTO era lungo: senza, sai che c\'e\' un tetto ma non di quanto tagliare');

  // niente paste: il testo monco non deve MAI raggiungere la cella
  assert.equal(pasted.length, 0);

  // l'ask resta open e ri-risponibile: il rifiuto non consuma nulla
  const retry = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'versione corta' }) });
  assert.equal(retry.status, 200);
  assert.deepEqual(pasted, [['cell-a', `[human reply · ask#${id}] versione corta`]]);

  // al limite esatto (3900) passa ancora: un tetto, non un rasoio
  const secondo = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'altro?', session: 'cell-a' }),
  })).json();
  const alTetto = await j(`/api/asks/${secondo.id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'y'.repeat(3900) }) });
  assert.equal(alTetto.status, 200, '3900 esatti passano');
});


test('answer: sanificazione control char (multiriga -> una riga, mai Invio)', async (t) => {
  const { j, pasted } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'riga1\nriga2\ttab' }) });
  assert.equal(r.status, 200);
  assert.equal(pasted[0][1], `[human reply · ask#${id}] riga1 riga2 tab`);
  // helper esportato: solo control char sostituiti, testo normale intatto
  assert.equal(sanitizePasteText('ok'), 'ok');
});

test('answer: replyLabel configurabile, sanificata e cappata', async (t) => {
  const { j, pasted } = await setup(t, { replyLabel: ` Ops\n${String.fromCharCode(0x1b)}Team ${'x'.repeat(80)}` });
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'procedo?', session: 'cell-a' }),
  })).json();
  assert.equal((await j(`/api/asks/${id}/answer`, {
    method: 'POST', body: JSON.stringify({ text: 'ok' }),
  })).status, 200);
  const label = pasted[0][1].match(/^\[(.*?) reply · ask#/)[1];
  assert.match(label, /^Ops  Team x+$/);
  assert.ok(label.length <= 48);
  assert.ok(!/[\x00-\x1f\x7f]/.test(label));
});

test('answer: id ignoto 404, text invalido 400, paste fallito 502 (ask resta aperto)', async (t) => {
  const { j, pasted } = await setup(t, { pasteOk: false });
  assert.equal((await j('/api/asks/deadbeef/answer', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status, 404);

  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  assert.equal((await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: '\n\n' }) })).status, 400);

  // paste fallito (sessione morta): 502 e l'ask RESTA aperto
  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'ciao' }) });
  assert.equal(r.status, 502);
  assert.equal(pasted.length, 1);
  const open = await (await j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 1);
});

// F2 (audit): claim atomico open->answering — il rollback su paste fallito
// rilascia il claim e l'ask resta risponibile al retry.
test('answer F2: dopo un paste fallito (rollback) il retry vince e chiude', async (t) => {
  const { j, pasted, pasteState } = await setup(t, { pasteOk: false });
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  assert.equal((await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'a' }) })).status, 502);
  pasteState.ok = true; // la cella e' tornata viva
  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'b' }) });
  assert.equal(r.status, 200);
  assert.equal(pasted.length, 2);
  assert.equal((await (await j('/api/asks?open=1')).json()).asks.length, 0);
});

// F2 (audit): due answer CONCORRENTI -> un solo paste; la seconda respinta 409.
// Il paste e' ritardato per tenere aperta la finestra di race che l'audit ha
// riprodotto (entrambe superavano il check answered prima del mark).
test('answer F2: race — due answer parallele, un solo paste, l\'altra 409', async (t) => {
  const pasted = [];
  const slowPaste = (session, text) => new Promise((resolve) => {
    pasted.push([session, text]);
    setTimeout(() => resolve(true), 50);
  });
  const { j } = await setup(t, { pasteImpl: slowPaste });
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'race?', session: 'cell-a' }),
  })).json();

  const [r1, r2] = await Promise.all([
    j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'prima' }) }),
    j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'seconda' }) }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'una vince, l\'altra 409');
  assert.equal(pasted.length, 1, 'UN SOLO paste deve raggiungere la TUI');
  // e l'ask e' chiuso: un terzo tentativo -> 409
  assert.equal((await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'terza' }) })).status, 409);
});

// F5 (audit): la creazione ask e' rate-limitata (globale per token) — session
// diverse NON bypassano.
test('create F5: rate-limit sulla creazione, session diverse non bypassano', async (t) => {
  const { j } = await setup(t);
  for (let i = 0; i < 6; i += 1) {
    const r = await j('/api/asks', {
      method: 'POST', body: JSON.stringify({ question: `q${i}`, session: `cell-s${i}` }),
    });
    assert.equal(r.status, 201, `ask ${i} deve passare`);
  }
  const blocked = await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q7', session: 'cell-fresh' }),
  });
  assert.equal(blocked.status, 429);
});

// F5 (audit): cap DURO sugli ask aperti — al cap il nuovo ask e' RIFIUTATO con
// errore chiaro; nessun ask aperto viene droppato in silenzio.
test('create F5: cap duro store — 105 create, dalla 101 respinte, nessun drop', async () => {
  const dir = tmpdir();
  const store = createAsksStore({ dir });
  let okCount = 0; let rejected = 0;
  for (let i = 0; i < 105; i += 1) {
    const out = store.create({ question: `q${i}`, session: 'cell-a' });
    if (out.ok) okCount += 1;
    else { rejected += 1; assert.equal(out.reason, 'cap'); assert.match(out.error, /cap|limite/i); }
  }
  assert.equal(okCount, 100);
  assert.equal(rejected, 5);
  assert.equal(store.list({ open: true }).length, 100, 'nessun ask aperto droppato');
});

test('READONLY F3: creazione ask gated 403 (nessuna persistenza), answer gated 403', async (t) => {
  const { j, dir, pasted, asks } = await setup(t, { readonly: true });
  // F3: in READONLY la creazione e' una scrittura durevole che genera domande
  // non risponibili -> 403 e asks.json non nasce
  const r = await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(path.join(dir, 'asks.json')), 'nessuna persistenza in READONLY');
  // answer di un ask preesistente (creato fuori banda): 403 senza paste
  const pre = asks.create({ question: 'pre', session: 'cell-a' });
  const r2 = await j(`/api/asks/${pre.ask.id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'x' }) });
  assert.equal(r2.status, 403);
  assert.equal(pasted.length, 0);
  // la LETTURA resta aperta
  assert.equal((await j('/api/asks?open=1')).status, 200);
});

test('persistenza: un ask aperto sopravvive al "restart" dello store', async (t) => {
  const { j, dir } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'resto?', session: 'cell-a' }),
  })).json();
  // nuovo store sulla stessa dir = riavvio server
  const store2 = createAsksStore({ dir });
  const open = store2.list({ open: true });
  assert.equal(open.length, 1);
  assert.equal(open[0].id, id);
  assert.equal(open[0].question, 'resto?');
});

// DELETE /asks/:id — scarta una domanda (dismiss). NON cancella la riga (lo
// storico serve): la marca `dismissed`. Dietro lo stesso mutGate degli altri
// mutanti (F3). Idempotente. 404 se ignoto, 409 se answering (claim attivo).
// Emette il frame per le UI aperte come fa POST /asks con emitRaw.
test('dismiss: marca dismissed (non cancella la riga), emette frame ask-dismissed, sparisce dagli open', async (t) => {
  const { j, dir, frames } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'scartami', session: 'cell-a' }),
  })).json();

  const r = await j(`/api/asks/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { dismissed: true, id });

  // La riga NON e' cancellata: sopravvive con dismissed:true (lo storico serve).
  const file = path.join(dir, 'asks.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8')).asks.find((a) => a.id === id);
  assert.ok(row, 'la riga sopravvive al dismiss (storico)');
  assert.equal(row.dismissed, true);
  assert.ok(row.dismissedTs, 'manca dismissedTs');

  // Frame per le UI aperte (card che sparisce senza aspettare il poll).
  assert.ok(frames.some((f) => f.type === 'ask-dismissed' && f.id === id), 'manca il frame ask-dismissed');

  // Sparito dagli open…
  const open = await (await j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 0);
  // …ma resta nello storico (GET senza ?open).
  const all = await (await j('/api/asks')).json();
  assert.ok(all.asks.some((a) => a.id === id), 'il ask dismissato deve restare nello storico');
});

test('dismiss: idempotente — scartare due volte non e\' un errore', async (t) => {
  const { j } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  assert.equal((await j(`/api/asks/${id}`, { method: 'DELETE' })).status, 200);
  const second = await j(`/api/asks/${id}`, { method: 'DELETE' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).dismissed, true);
});

test('dismiss: 404 per id inesistente (un id esistente invece 200)', async (t) => {
  const { j } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  assert.equal((await j(`/api/asks/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await j('/api/asks/deadbeef', { method: 'DELETE' })).status, 404);
});

test('dismiss: 409 se l\'ask e\' in stato answering (claim attivo)', async (t) => {
  const { j, asks } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  // Claim deterministico diretto sullo store: simula una answer in corso
  // (paste pending). Il dismiss non compete con una risposta in corso.
  const claim = asks.claim(id);
  assert.equal(claim.ok, true);
  const del = await j(`/api/asks/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 409);
});

test('dismiss READONLY F3: gated 403 (mutazione durevole, niente stato)', async (t) => {
  const { j, asks, frames } = await setup(t, { readonly: true });
  // ask preesistente creato fuori banda
  const pre = asks.create({ question: 'pre', session: 'cell-a' });
  const r = await j(`/api/asks/${pre.ask.id}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  assert.ok(!frames.some((f) => f.type === 'ask-dismissed'), 'nessun frame in READONLY');
});

// F-02: un ask dismissato NON e' piu' claimable. Senza questa guardia in claim()
// la sequenza dismiss -> claim -> commit lascia l'ask nello stato ibrido
// `dismissed && answered`. Il verso opposto (dismiss mentre answering -> 409)
// regge gia'; questo e' il buco che manca.
test('F-02: un ask dismissato non e\' piu\' claimable (niente dismissed && answered)', async (t) => {
  const { j, asks } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  assert.equal(asks.dismiss(id).ok, true);
  const claim = asks.claim(id);
  assert.equal(claim.ok, false, 'claim su un ask dismissato deve fallire');
  assert.equal(claim.reason, 'dismissed');
});

test('F-02: answer su un ask dismissato -> 409, nessun paste, resta solo dismissed', async (t) => {
  const { j, asks, pasted } = await setup(t);
  const { id } = await (await j('/api/asks', {
    method: 'POST', body: JSON.stringify({ question: 'q', session: 'cell-a' }),
  })).json();
  asks.dismiss(id);
  const r = await j(`/api/asks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text: 'x' }) });
  assert.equal(r.status, 409);
  assert.equal(pasted.length, 0, 'nessun paste su un ask dismissato');
  // Stato coerente: dismissed SI, answered MAI true (niente ibrido).
  const row = asks.get(id);
  assert.equal(row.dismissed, true);
  assert.equal(row.answered, false);
});
