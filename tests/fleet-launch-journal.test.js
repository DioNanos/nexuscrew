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


// ---------------------------------------------------------------------------
// Ordine degli effetti, percorso completo e guasti dell'impegno delle fasi
// ---------------------------------------------------------------------------

const { OWNER_INSTANCE_ID } = W;

function leggiRecord(d) {
  const r = launchTarget.leggi(d.filesRoot, d.sessione);
  return r.stato === 'presente' ? r.record : r;
}

function nuoveSessioni(d) {
  return W.chiamateTmux(d).filter((a) => a.includes('new-session'));
}

function avviaSnapshot(d, nome) {
  const to = path.join(d.root, nome);
  return { from: W.fileRecord(d), to };
}

test('percorso completo (other): il record e\' prepared prima degli effetti, creating alla new-session, created prima del respawn, attested alla fine', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const snapNew = avviaSnapshot(d, 'snap-new-session.json');
  const snapRespawn = avviaSnapshot(d, 'snap-respawn.json');
  W.impostaScenario(d, { snapshot: snapNew, snapshotRespawn: snapRespawn });
  let alBroker = null;
  const { runtime } = W.apriRuntime(d, {
    issue: async () => {
      alBroker = leggiRecord(d);
      return { socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.up(d.cella);
  assert.equal(r.ok, true);

  assert.equal(alBroker.phase, 'prepared', 'quando il broker emette il ticket il record c\'e\' gia\'');
  assert.equal(alBroker.launchId.length, 16);
  assert.equal(alBroker.family, 'other');
  assert.equal(alBroker.sessionId, null, 'nessun falso id nello schema v2');

  const allaNewSession = JSON.parse(fs.readFileSync(snapNew.to, 'utf8'));
  assert.equal(allaNewSession.phase, 'creating', 'creating e\' sul disco quando la new-session parte');
  assert.equal(allaNewSession.sessionId, undefined);

  const alRespawn = JSON.parse(fs.readFileSync(snapRespawn.to, 'utf8'));
  assert.equal(alRespawn.phase, 'created', 'created e\' sul disco prima del respawn');
  assert.equal(alRespawn.sessionId, '$5');
  assert.equal(alRespawn.windowId, '@7');
  assert.equal(alRespawn.paneId, '%9');
  assert.equal(alRespawn.holdPid, 1111, 'identita\' del placeholder nei suoi campi');
  assert.equal(alRespawn.panePid, undefined, 'il pid del placeholder non e\' mai il supervisore');

  const finale = leggiRecord(d);
  assert.equal(finale.phase, 'attested');
  assert.equal(finale.panePid, 2222, 'il supervisore reale');
  assert.equal(finale.holdPid, 1111, 'il placeholder resta distinto');
  assert.notEqual(finale.panePid, finale.holdPid);
  assert.equal(finale.incerto, false);
  assert.equal(finale.qualificato, true);
  assert.equal(finale.launchId, alBroker.launchId);
  assert.equal(finale.daemonInc, alBroker.daemonInc);
  assert.equal(finale.cellId, d.cella);
});

test('percorso completo senza identita\' leggibile: attested senza pid, mai un pid del placeholder', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  // Ne' il placeholder ne' il supervisore rispondono con un pane_pid.
  W.impostaScenario(d, { server: '', hold: '', supervisor: '' });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.up(d.cella);
  assert.equal(r.ok, true);
  const rec = leggiRecord(d);
  assert.equal(rec.phase, 'attested');
  assert.equal(rec.panePid, null);
  assert.equal(rec.paneStarttime, null);
  assert.equal(rec.holdPid, null);
  assert.equal(rec.qualificato, true);
});

test('supervisore illeggibile dopo il respawn con placeholder noto: il lancio fallisce e il record non sopravvive', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { postRespawn: 'incomplete' } });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'POST_RESPAWN_IDENTITY_UNKNOWN');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
  assert.ok(W.chiamateTmux(d).some((a) => a.join(' ').includes('kill-session')), 'sessione nostra fermata sul canale posseduto');
});

test('ordine degli effetti (vl): il record prepared precede riserva, contesto, registro, selettore e broker', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const alBroker = {};
  const { runtime } = W.apriRuntime(d, {
    issue: async () => {
      alBroker.record = leggiRecord(d);
      alBroker.lease = W.lease(d).length;
      // Anche gli effetti precedenti al broker (registro) sono gia' avvenuti: il
      // punto e' che il record c'era prima di tutti.
      return { socketPath: path.join(d.root, 'broker.sock'), nonce: 'b'.repeat(64) };
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  // La creazione e' ignota (nessun frame) cosi' il lancio si ferma in modo conservativo.
  W.impostaScenario(d, { newSession: 'eof' });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
  assert.equal(alBroker.record.phase, 'prepared');
  assert.equal(alBroker.record.family, 'vl');
  assert.deepStrictEqual(alBroker.record.res, {
    vlOwner: OWNER_INSTANCE_ID,
    vlRoot: alBroker.record.res.vlRoot,
  });
  assert.ok(path.isAbsolute(alBroker.record.res.vlRoot));
  assert.equal(alBroker.record.ownerInstanceId, OWNER_INSTANCE_ID);
  assert.equal(alBroker.lease, 1, 'la claim c\'era gia\' quando il broker ha emesso: record e claim insieme');
});

test('prepared non attestato: zero effetti, nessuna claim, nessun ticket, nessun tmux', async (t) => {
  for (const famiglia of ['other', 'vl']) {
    const d = W.scriviMondo({ famiglia });
    t.after(() => W.pulisci(d));
    const originale = launchTarget.registraPrepared;
    launchTarget.registraPrepared = () => ({ ok: false, motivo: 'scrittura', pubblicato: 'no' });
    let calls;
    try {
      const { runtime, calls: c } = W.apriRuntime(d, {});
      calls = c;
      t.after(() => { try { runtime.shutdown(); } catch (_) {} });
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
    } finally { launchTarget.registraPrepared = originale; }
    assert.equal(calls.issue, 0, `${famiglia}: nessun ticket`);
    assert.deepStrictEqual(W.lease(d), [], `${famiglia}: nessuna claim`);
    assert.equal(W.chiamateTmux(d).filter((a) => a.includes('new-session')).length, 0);
    assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
    assert.equal(fs.existsSync(path.join(d.home, '.nexuscrew')), false, `${famiglia}: nessun file di NC creato`);
    assert.equal(fs.existsSync(path.join(d.filesRoot, 'launch-current')), false);
  }
});

test('prepared con esito incerto (rename fatto): nessun effetto e il record dell\'esito incerto viene tolto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const originale = launchTarget.registraPrepared;
  // Il record e' sul disco ma l'esito dichiarato e' incerto.
  launchTarget.registraPrepared = (...args) => {
    originale.apply(launchTarget, args);
    return { ok: false, motivo: 'scrittura', pubblicato: 'incerto' };
  };
  let calls;
  try {
    const { runtime, calls: c } = W.apriRuntime(d, {});
    calls = c;
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
  } finally { launchTarget.registraPrepared = originale; }
  assert.equal(calls.issue, 0);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente', 'nessun effetto: il record si puo\' togliere');
});

test('creating non attestato (errore prima del rename): la new-session non parte e il lancio si chiude', async (t) => {
  for (const famiglia of ['other', 'vl']) {
    const d = W.scriviMondo({ famiglia });
    t.after(() => W.pulisci(d));
    const originale = launchTarget.avanza;
    launchTarget.avanza = (root, sessione, o) => (o.a === 'creating'
      ? { ok: false, codice: 'scrittura', pubblicato: 'no' }
      : originale.call(launchTarget, root, sessione, o));
    try {
      const { runtime } = W.apriRuntime(d, {});
      t.after(() => { try { runtime.shutdown(); } catch (_) {} });
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
    } finally { launchTarget.avanza = originale; }
    assert.deepStrictEqual(nuoveSessioni(d), [], `${famiglia}: nessuna new-session`);
    assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente', `${famiglia}: record tolto`);
    assert.deepStrictEqual(W.lease(d), [], `${famiglia}: claim rilasciata`);
  }
});

test('creating con esito incerto (rename fatto): nessuna new-session, la barriera resta e il record non torna indietro', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const originale = launchTarget.avanza;
  launchTarget.avanza = (root, sessione, o) => {
    const r = originale.call(launchTarget, root, sessione, o);
    return o.a === 'creating' ? { ok: false, codice: 'scrittura', pubblicato: 'incerto' } : r;
  };
  try {
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
    assert.deepStrictEqual(nuoveSessioni(d), [], 'su un commit incerto non si avvia niente');
    assert.equal(leggiRecord(d).phase, 'creating', 'la fase nuova e\' visibile e non si fa tornare indietro');
    assert.equal(W.lease(d).length, 1, 'claim conservata');
    // Lo stesso processo non rilancia sopra un esito incerto.
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
  } finally { launchTarget.avanza = originale; }
});

test('created non attestato: la sessione nata e\' fermata sul canale posseduto e il lancio si chiude', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const originale = launchTarget.avanza;
  launchTarget.avanza = (root, sessione, o) => (o.a === 'created'
    ? { ok: false, codice: 'scrittura', pubblicato: 'no' }
    : originale.call(launchTarget, root, sessione, o));
  try {
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
  } finally { launchTarget.avanza = originale; }
  assert.ok(W.chiamateTmux(d).some((a) => a.join(' ').includes('kill-session')));
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('attested non attestato: nessun successo, record non ripulito (vl) o chiuso con la sessione (other)', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const originale = launchTarget.avanza;
  launchTarget.avanza = (root, sessione, o) => (o.a === 'attested'
    ? { ok: false, codice: 'scrittura', pubblicato: 'incerto' }
    : originale.call(launchTarget, root, sessione, o));
  try {
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'LAUNCH_TARGET_UNWRITABLE');
  } finally { launchTarget.avanza = originale; }
  assert.ok(W.chiamateTmux(d).some((a) => a.join(' ').includes('kill-session')));
});

// --- Esiti di creazione: solo il rifiuto PROVATO scioglie ------------------

const IGNOTI = [
  ['timeout senza frame', { newSession: 'hang' }],
  ['EOF prima del frame', { newSession: 'eof' }],
  ['id malformati', { newSession: 'bad-ids' }],
  ['riga extra nel frame', { newSession: 'extra-line' }],
  ['rifiuto generico', { newSession: 'generic-error' }],
  ['«duplicate» fuori dal frame', { newSession: 'duplicate-outside' }],
  ['duplicate di un\'altra sessione', { newSession: 'duplicate-other-name' }],
  ['duplicate con testo in piu\'', { newSession: 'duplicate-extra' }],
  ['frame troncato', { newSession: 'truncated' }],
];

for (const [nome, scenario] of IGNOTI) {
  test(`creazione non provata rifiutata (${nome}): record creating e claim restano, mai SESSION_DUPLICATE`, async (t) => {
    for (const famiglia of ['other', 'vl']) {
      const d = W.scriviMondo({ famiglia, scenario });
      t.after(() => W.pulisci(d));
      const { runtime } = W.apriRuntime(d, {});
      t.after(() => { try { runtime.shutdown(); } catch (_) {} });
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'NEW_SESSION_FAILED',
        `${famiglia}/${nome}`);
      const rec = leggiRecord(d);
      assert.equal(rec.phase, 'creating', `${famiglia}/${nome}: il record resta alla fase che dice «creazione in volo»`);
      assert.equal(rec.incerto, true);
      if (famiglia === 'vl') assert.equal(W.lease(d).length, 1, `${famiglia}/${nome}: claim trattenuta`);
      assert.ok(!W.chiamateTmux(d).some((a) => a.join(' ').includes('kill-session')),
        'nessun kill: la sessione, se c\'e\', non e\' dimostrabilmente nostra');
      // Il blocco si conserva: un nuovo up non passa.
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
    }
  });
}

test('rifiuto provato: stato abortito DUREVOLE prima del cleanup, poi record e claim chiusi', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl', scenario: { newSession: 'duplicate' } });
  t.after(() => W.pulisci(d));
  const viste = [];
  const originale = launchTarget.avanza;
  launchTarget.avanza = (root, sessione, o) => {
    const r = originale.call(launchTarget, root, sessione, o);
    if (o.a === 'aborted') viste.push({ record: leggiRecord(d), claim: W.lease(d).length });
    return r;
  };
  try {
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SESSION_DUPLICATE');
  } finally { launchTarget.avanza = originale; }
  assert.equal(viste.length, 1);
  assert.equal(viste[0].record.phase, 'aborted', 'subito dopo la scrittura il disco dice «abortito»');
  assert.equal(viste[0].record.abortReason, 'duplicate-session');
  assert.equal(viste[0].claim, 1, 'la claim e\' ancora li\' quando il terminale e\' commitato');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
  assert.deepStrictEqual(W.lease(d), []);
});

test('rifiuto provato ma abort non attestato: la barriera resta, nessun rilascio', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl', scenario: { newSession: 'duplicate' } });
  t.after(() => W.pulisci(d));
  const originale = launchTarget.avanza;
  launchTarget.avanza = (root, sessione, o) => (o.a === 'aborted'
    ? { ok: false, codice: 'scrittura', pubblicato: 'no' }
    : originale.call(launchTarget, root, sessione, o));
  try {
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SESSION_DUPLICATE');
  } finally { launchTarget.avanza = originale; }
  assert.equal(leggiRecord(d).phase, 'creating');
  assert.equal(W.lease(d).length, 1);
});

// --- Crash a ogni confine di scrittura (figlio SIGKILL) --------------------

const CONFINI = [
  { nome: 'prima di prepared', crash: { dove: 'record', fn: 'registraPrepared', quando: 'prima' }, fase: null, tmuxNew: false, claim: false },
  { nome: 'dopo prepared', crash: { dove: 'record', fn: 'registraPrepared', quando: 'dopo' }, fase: 'prepared', tmuxNew: false, claim: false },
  { nome: 'prima di creating', crash: { dove: 'record', fn: 'avanza', quando: 'prima', fase: 'creating' }, fase: 'prepared', tmuxNew: false, claim: true },
  { nome: 'dopo creating', crash: { dove: 'record', fn: 'avanza', quando: 'dopo', fase: 'creating' }, fase: 'creating', tmuxNew: false, claim: true },
  { nome: 'prima di created', crash: { dove: 'record', fn: 'avanza', quando: 'prima', fase: 'created' }, fase: 'creating', tmuxNew: true, claim: true },
  { nome: 'dopo created', crash: { dove: 'record', fn: 'avanza', quando: 'dopo', fase: 'created' }, fase: 'created', tmuxNew: true, claim: true },
  { nome: 'prima di attested', crash: { dove: 'record', fn: 'avanza', quando: 'prima', fase: 'attested' }, fase: 'created', tmuxNew: true, claim: true },
  { nome: 'dopo attested', crash: { dove: 'record', fn: 'avanza', quando: 'dopo', fase: 'attested' }, fase: 'attested', tmuxNew: true, claim: true },
];

for (const c of CONFINI) {
  test(`crash ${c.nome} (other): il disco dice cosa e\' successo e il blocco si conserva`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const r = muoreAl(d, { crash: c.crash });
    assert.equal(r.signal, 'SIGKILL', `il figlio doveva morire al confine (stdout=${r.stdout} stderr=${r.stderr})`);
    const letto = launchTarget.leggi(d.filesRoot, d.sessione);
    if (c.fase === null) {
      assert.equal(letto.stato, 'assente');
    } else {
      assert.equal(letto.stato, 'presente');
      assert.equal(letto.record.phase, c.fase);
    }
    assert.equal(nuoveSessioni(d).length > 0, c.tmuxNew, 'new-session emessa se e solo se creating e\' stato impegnato e superato');
    // Un secondo runtime sullo stesso disco: il blocco non si scioglie da solo.
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    if (c.fase === null) {
      const ok = await runtime.up(d.cella);
      assert.equal(ok.ok, true, 'senza record non c\'e\' niente da conservare');
    } else if (c.fase === 'attested') {
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SESSION_DUPLICATE');
      assert.equal(leggiRecord(d).phase, 'attested');
    } else {
      await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
      assert.equal(leggiRecord(d).phase, c.fase, 'il record non e\' stato toccato');
      // Il down senza prova non agisce: nessun kill e record intatto.
      const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
      await assert.rejects(() => runtime.down(d.cella), (e) => e.fleetCode === 'IDENTITY_UNVERIFIED');
      assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
      assert.ok(!W.chiamateTmux(d).some((a) => a.join(' ').includes('kill-session')));
    }
  });
}

test('crash al broker (vl): record prepared e claim insieme, il blocco si conserva', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const r = muoreAl(d, { crash: { dove: 'issue' } });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(leggiRecord(d).phase, 'prepared');
  assert.equal(W.lease(d).length, 1);
  assert.deepStrictEqual(nuoveSessioni(d), []);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
  await assert.rejects(() => runtime.down(d.cella), (e) => e.fleetCode === 'IDENTITY_UNVERIFIED');
  assert.equal(W.lease(d).length, 1, 'il down senza prova non scioglie la claim');
  assert.equal(leggiRecord(d).phase, 'prepared');
});

test('crash dopo l\'abort terminale (vl): il disco dice «abortito» e la claim c\'e\' ancora', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl', scenario: { newSession: 'duplicate' } });
  t.after(() => W.pulisci(d));
  const r = muoreAl(d, { crash: { dove: 'record', fn: 'avanza', quando: 'dopo', fase: 'aborted' } });
  assert.equal(r.signal, 'SIGKILL', `${r.stdout} ${r.stderr}`);
  const rec = leggiRecord(d);
  assert.equal(rec.phase, 'aborted');
  assert.equal(rec.abortReason, 'duplicate-session');
  assert.equal(W.lease(d).length, 1);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

// --- Riserva fallita o incerta (vl) ----------------------------------------

test('riserva in collisione: il record prepared si toglie e la claim altrui non si tocca', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const radici = require('../lib/fleet/vl-roots.js');
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  const altrui = await radici.riserva({
    home: d.home, root, launchId: 'ee'.repeat(8), ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000,
  });
  assert.equal(altrui.ok, true);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'VL_ROOT_COLLISION');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
  assert.equal(W.lease(d).length, 1, 'la claim dell\'altro lancio e\' intatta');
  const lease = JSON.parse(fs.readFileSync(W.lease(d)[0], 'utf8'));
  assert.equal(lease.launchId, 'ee'.repeat(8));
});

test('riserva incerta (claim illeggibile): nessuna conclusione dal silenzio, nessun rilascio alla cieca', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const radici = require('../lib/fleet/vl-roots.js');
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  const altrui = await radici.riserva({
    home: d.home, root, launchId: 'ee'.repeat(8), ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000,
  });
  assert.equal(altrui.ok, true);
  // Danneggia la lease: la riserva successiva non puo' classificarla.
  fs.writeFileSync(W.lease(d)[0], '{ non json');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'CLAIM_UNCERTAIN');
  assert.equal(W.lease(d).length, 1, 'la lease (illeggibile) non e\' stata toccata');
  assert.equal(fs.readFileSync(W.lease(d)[0], 'utf8'), '{ non json');
  // Il rilascio esatto non ha dato `released`: il record del lancio resta a dire che c'e' una barriera.
  const rec = leggiRecord(d);
  assert.equal(rec.phase, 'prepared');
  assert.equal(rec.incerto, true);
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

test('rilascio incerto nel cleanup: il riferimento alla claim e il record si conservano', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  // ensureProtection lancia alla seconda chiamata (subito prima della creazione):
  // cleanup pre-creazione. Un attimo prima la lease viene resa illeggibile, cosi'
  // il rilascio esatto risponde «incerto» e non `released`.
  let n = 0;
  const { runtime } = W.apriRuntime(d, {
    ensureProtection: async () => {
      n += 1;
      if (n === 2) {
        fs.writeFileSync(W.lease(d)[0], '{ non json');
        throw new Error('protezione non disponibile');
      }
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SHARED_SERVER_UNPROTECTED');
  assert.equal(leggiRecord(d).phase, 'prepared', 'claim non sciolta: il record resta');
  assert.equal(W.lease(d).length, 1);
  assert.deepStrictEqual(nuoveSessioni(d), []);
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

test('cleanup pre-creazione (vl): claim esatta rilasciata, poi il record del nostro lancio', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  let n = 0;
  const { runtime } = W.apriRuntime(d, {
    ensureProtection: async () => { n += 1; if (n >= 2) throw new Error('protezione non disponibile'); },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const ordine = [];
  const originale = launchTarget.rimuoviDelLancio;
  launchTarget.rimuoviDelLancio = (...a) => {
    ordine.push({ passo: 'record', claim: W.lease(d).length });
    return originale.apply(launchTarget, a);
  };
  try {
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'SHARED_SERVER_UNPROTECTED');
  } finally { launchTarget.rimuoviDelLancio = originale; }
  assert.deepStrictEqual(ordine, [{ passo: 'record', claim: 0 }], 'il record si toglie DOPO la claim, una volta sola');
  assert.deepStrictEqual(W.lease(d), []);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});
