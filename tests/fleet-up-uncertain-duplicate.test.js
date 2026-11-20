'use strict';
// La corsa fra le due letture di presenza di uno stesso up su un record
// INCERTO con canale posseduto riagganciato.
//
// Il blocco del record incerto interroga la presenza sul canale posseduto e,
// se la risposta e' POSITIVA, oggi non decide li': il rifiuto dipende dalla
// RE-INTERROGAZIONE del passo (1) del preflight, sulla stessa connessione. Se
// la sessione muore fra le due letture, il passo (1) osserva un'assenza
// qualificata, chiude il canale, l'up prosegue e la registrazione del lancio
// nuovo SOVRASCRIVE il record incerto mai riconciliato: l'evidenza della
// pratica vecchia e' distrutta mentre il lancio vecchio potrebbe essere
// ancora vivo.
//
// Il contratto qui inchiodato: una presenza POSITIVA sul canale posseduto
// rifiuta SUBITO con 409 SESSION_DUPLICATE (stesso testo e fase del passo
// (1)), senza toccare canale, entry del canale e record; nessuna seconda
// lettura, nessun nuovo lancio, nessuna quarantena. Il canale riagganciato e'
// intercettato avvolgendo tmux-control.apri con un canale copione che risponde
// alla lettura di adozione con i quattro campi esatti del record.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const tc = require('../lib/fleet/tmux-control.js');
const W = require('./helpers/launch-world.js');

const { OWNER_INSTANCE_ID } = W;
const LID = 'ab'.repeat(8);
const BOOT_ORA = '11111111-1111-4111-8111-111111111111';
const NS = '4026531836';

const nodoOra = () => () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS });

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

function scrivi(d, fase, {
  bootId = BOOT_ORA, pidNs = NS, owner = null, created = {}, attested = null, launchId = LID,
} = {}) {
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId, family: 'other', cellId: d.cella, ownerInstanceId: owner, tmuxSocket: require('../lib/runtime/env.js').sharedTmuxSocketPath(),
    bootId, pidNs, daemonInc: 'inc-0', res: null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const passi = ['creating', 'created', 'attested'];
  let da = 'prepared';
  for (const a of passi) {
    if (fase === da) break;
    const campi = a === 'created' ? { sessionId: '$5', windowId: '@7', paneId: '%9', ...created }
      : a === 'attested' ? { ...attested } : {};
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
    da = a;
  }
}

test('record incerto con canale posseduto: presenza positiva provata -> 409 duplicato immediato, nessun teardown, record intatto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  // Incarnazioni VIVE di server e supervisore: la riadozione del canale
  // qualifica e il blocco incerto lavora sul canale posseduto.
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: srv.pid, serverStarttime: nascitaSrv },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
  });
  assert.equal(launchTarget.marcaIncerto(d.filesRoot, d.sessione), true, 'marca incerto');
  const recordPrima = fs.readFileSync(W.fileRecord(d), 'utf8');

  // Canale copione: la lettura di adozione risponde i quattro campi ESATTI del
  // record; la presenza e' positiva alla PRIMA interrogazione (la sessione
  // vive) e assente QUALIFICATA alla SECONDA (la sessione muore fra le due
  // letture dello stesso up: la corsa). La coda si consuma e si ripristina
  // dal test fra un up e l'altro; esaurita, la presenza resta positiva.
  const atteso = `${srv.pid} $5 %9 ${sup.pid}`;
  const usi = { has: 0, chiusi: 0, kill: 0, aperta: 0 };
  const copione = { coda: ['positiva', 'assente'] };
  const canaleFinto = {
    morto: () => false,
    formato: async (target) => (target === '$5' ? { ok: true, testo: atteso } : { ok: false }),
    hasSession: async () => {
      usi.has += 1;
      const v = copione.coda.shift() || 'positiva';
      return v === 'assente'
        ? { ok: false, assente: true, testo: ["can't find session: $5"] }
        : { ok: true, testo: [] };
    },
    killSession: async () => { usi.kill += 1; return { ok: true }; },
    chiudi: () => { usi.chiusi += 1; },
  };
  const origApri = tc.apri;
  tc.apri = async () => { usi.aperta += 1; return canaleFinto; };
  t.after(() => { tc.apri = origApri; });

  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });

  const err = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(err, 'la presenza positiva rifiuta l\'up: oggi invece prosegue e sovrascrive il record incerto');
  assert.equal(err.status, 409);
  assert.equal(err.fleetCode, 'SESSION_DUPLICATE');
  assert.equal(err.message, 'session already running');
  assert.equal(err.fleetPhase, 'preflight');
  // Il rifiuto arriva alla PRIMA prova positiva: nessuna seconda lettura
  // (la seconda, con la sessione morta, e' la porta della corsa).
  assert.equal(usi.has, 1, `una sola interrogazione di presenza, non ${usi.has}`);
  assert.equal(copione.coda.length, 1, "la lettura d'assenza della corsa non viene mai emessa");
  // Nessun teardown: canale ed entry si rilasciano sempre insieme, e qui il
  // canale non si chiude mai.
  assert.equal(usi.chiusi, 0, 'il canale posseduto non si chiude');
  assert.equal(usi.kill, 0, 'nessun kill-session');
  // Record incerto byte-identico, stessa identita' di lancio, nessuna quarantena.
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), recordPrima, 'record byte-identico');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.equal(dopo.record.incerto, true, 'il record resta incerto');
  assert.equal(dopo.record.launchId, LID, 'nessuna registrazione di lancio nuovo');
  assert.ok(!fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), 'nessuna quarantena');
  // Nessun effetto di lancio: zero ticket, zero new-session.
  assert.equal(calls.issue, 0, 'nessun ticket');
  const comandi = W.chiamateTmux(d).map((c) => JSON.stringify(c));
  assert.ok(!comandi.some((c) => c.includes('new-session')), 'nessuna new-session emessa');

  // L'ENTRY del canale e' ancora posseduta dal runtime: un secondo up ripercorre
  // lo stesso blocco SULLO STESSO canale (nessuna nuova adozione) e rifiuta di
  // nuovo alla presenza positiva. La sessione non e' mai stata osservata morta:
  // il copione resta positivo.
  copione.coda = [];
  const err2 = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(err2, 'il secondo up rifiuta');
  assert.equal(err2.status, 409);
  assert.equal(err2.fleetCode, 'SESSION_DUPLICATE');
  assert.equal(usi.has, 2, `due interrogazioni totali (una per up), non ${usi.has}`);
  assert.equal(usi.aperta, 1, "nessuna seconda adozione del canale: l'entry conservata e' ancora posseduta");
  assert.equal(usi.chiusi, 0, 'il canale resta aperto');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), recordPrima, 'record ancora byte-identico');
  assert.equal(calls.issue, 0, 'ancora nessun ticket');
});
