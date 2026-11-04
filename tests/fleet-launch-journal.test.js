'use strict';
// Il giornale del lancio: il record durevole nasce PRIMA di ogni effetto e
// una creazione rifiutata o un fallimento prima della creazione non lasciano
// ne' record ne' claim. Mondo finto e isolato (tests/helpers/launch-world.js):
// nessun tmux reale, nessun servizio vivo. I crash sono SIGKILL sul figlio di
// test esatto (tests/helpers/launch-crash-child.cjs).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const W = require('./helpers/launch-world.js');

const FIGLIO = path.join(__dirname, 'helpers', 'launch-crash-child.cjs');

function muoreAl(descr, spec) {
  const r = spawnSync(process.execPath, [FIGLIO, JSON.stringify({ descr, ...spec })], {
    encoding: 'utf8', timeout: 60000,
  });
  return r;
}

test('una claim VL non esiste mai senza il record del lancio', (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  // Il figlio muore quando il broker emette il ticket: a quel punto la root
  // VL e' gia' riservata, il contesto scritto e il registro impegnato.
  const r = muoreAl(d, { crash: { dove: 'issue' } });
  assert.equal(r.signal, 'SIGKILL', `il figlio doveva morire al confine (stdout=${r.stdout})`);
  const claim = W.lease(d);
  assert.equal(claim.length, 1, 'la claim della root e\' presente dopo il crash');
  const letto = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(letto.stato, 'presente',
    'con la claim sul disco deve esistere anche il record del lancio (altrimenti nessun percorso la libera)');
});

test('ensureProtection che lancia prima della creazione non trattiene il record', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  let chiamate = 0;
  const { runtime } = W.apriRuntime(d, {
    ensureProtection: async () => {
      chiamate += 1;
      if (chiamate >= 2) throw new Error('protezione non disponibile');
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SHARED_SERVER_UNPROTECTED');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente',
    'nessuna creazione e\' stata emessa: il record non deve restare');
  assert.equal(W.chiamateTmux(d).filter((a) => a.includes('new-session')).length, 0,
    'nessuna new-session emessa');
  // Il lancio successivo non e' bloccato da un record orfano.
  const { runtime: secondo } = W.apriRuntime(d, {});
  t.after(() => { try { secondo.shutdown(); } catch (_) {} });
  const r = await secondo.up(d.cella);
  assert.equal(r.ok, true);
});

test('duplicate session provato chiude il NOSTRO record senza toccare l\'omonima', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { newSession: 'duplicate' } });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SESSION_DUPLICATE');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente',
    'il rifiuto provato non lascia un record: la sessione omonima non e\' nostra');
  const comandi = W.chiamateTmux(d).map((a) => a.join(' '));
  assert.ok(!comandi.some((c) => c.includes('kill-session')), 'nessun kill sull\'omonima');
});

test('duplicate session provato scioglie la claim del lancio rifiutato (vl)', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl', scenario: { newSession: 'duplicate' } });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SESSION_DUPLICATE');
  assert.equal(W.lease(d).length, 0, 'la claim del nostro lancio e\' stata rilasciata');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});
