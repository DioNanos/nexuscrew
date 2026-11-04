'use strict';
// Il record v2 del lancio (launch-targets/<sessione>.json): fasi monotone,
// lettura compatibile con il v1, scritture atomiche con esito distinto per
// stadio. Nessun runtime, nessun tmux: solo il modulo del record su un
// filesystem temporaneo e, per i guasti, fs avvolto dal lato del test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lt = require('../lib/fleet/launch-target.js');

const SESSIONE = 'cloud-Giornale';
const LAUNCH = 'ab'.repeat(8);
const ALTRO = 'cd'.repeat(8);
const OWNER = 'ef'.repeat(16);
const UUID = '12345678-1234-1234-1234-123456789abc';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lt-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'launch-targets', `${SESSIONE}.json`) };
}

function prepara(w, extra = {}) {
  return lt.registraPrepared(w.root, SESSIONE, {
    launchId: LAUNCH, family: 'other', cellId: 'Giornale', tmuxSocket: '/tmp/nc-sock',
    daemonInc: 'inc-1', bootId: UUID, ora: 1000, ...extra,
  });
}

const CREATED = { sessionId: '$5', windowId: '@7', paneId: '%9', serverPid: 4242, holdPid: 1111, holdStarttime: 77, serverStarttime: 55 };

function percorsoCompleto(w) {
  assert.deepStrictEqual(prepara(w), { ok: true });
  assert.deepStrictEqual(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }), { ok: true });
  assert.deepStrictEqual(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'created', campi: CREATED }), { ok: true });
  assert.deepStrictEqual(lt.avanza(w.root, SESSIONE, {
    launchId: LAUNCH, da: 'created', a: 'attested', campi: { panePid: 2222, paneStarttime: 999 },
  }), { ok: true });
}

test('le quattro fasi si impegnano una alla volta e il record le dichiara', (t) => {
  const w = mondo(t);
  assert.deepStrictEqual(prepara(w), { ok: true });
  let r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.stato, 'presente');
  assert.equal(r.record.version, 2);
  assert.equal(r.record.phase, 'prepared');
  assert.equal(r.record.qualificato, true);
  assert.equal(r.record.incerto, true);
  assert.equal(r.record.sessionId, null, 'nessun falso $0 nello schema v2');
  assert.equal(r.record.paneId, null, 'nessun falso %0 nello schema v2');
  assert.equal(r.record.bootId, UUID);
  assert.equal(r.record.daemonInc, 'inc-1');
  assert.equal(r.record.panePid, null);

  assert.ok(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).ok);
  r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.record.phase, 'creating');
  assert.equal(r.record.incerto, true);
  assert.equal(r.record.sessionId, null);

  assert.ok(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'created', campi: CREATED }).ok);
  r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.record.phase, 'created');
  assert.equal(r.record.sessionId, '$5');
  assert.equal(r.record.windowId, '@7');
  assert.equal(r.record.paneId, '%9');
  assert.equal(r.record.holdPid, 1111, 'identita\' del placeholder');
  assert.equal(r.record.holdStarttime, 77);
  assert.equal(r.record.panePid, null, 'il pid del placeholder non e\' mai il supervisore');
  assert.equal(r.record.paneStarttime, null);
  assert.equal(r.record.incerto, true, 'created resta incerto');

  assert.ok(lt.avanza(w.root, SESSIONE, {
    launchId: LAUNCH, da: 'created', a: 'attested', campi: { panePid: 2222, paneStarttime: 999 },
  }).ok);
  r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.record.phase, 'attested');
  assert.equal(r.record.panePid, 2222);
  assert.equal(r.record.paneStarttime, 999);
  assert.equal(r.record.holdPid, 1111, 'il placeholder resta nei SUOI campi');
  assert.equal(r.record.incerto, false);
  assert.equal(r.record.qualificato, true);
  assert.equal(fs.statSync(w.file).mode & 0o777, 0o600);
});

test('l\'avanzamento e\' solo in avanti, di una fase, sullo stesso lancio', (t) => {
  const w = mondo(t);
  prepara(w);
  const prima = fs.readFileSync(w.file, 'utf8');
  const rifiuti = [
    [{ launchId: LAUNCH, da: 'prepared', a: 'created', campi: CREATED }, 'transizione'],
    [{ launchId: LAUNCH, da: 'prepared', a: 'attested', campi: { panePid: 1 } }, 'transizione'],
    [{ launchId: LAUNCH, da: 'prepared', a: 'prepared' }, 'transizione'],
    [{ launchId: LAUNCH, da: 'creating', a: 'prepared' }, 'transizione'],
    [{ launchId: LAUNCH, da: 'attested', a: 'created', campi: CREATED }, 'transizione'],
    [{ launchId: LAUNCH, da: 'prepared', a: 'inesistente' }, 'transizione'],
    [{ launchId: ALTRO, da: 'prepared', a: 'creating' }, 'launch-diverso'],
    [{ launchId: LAUNCH, da: 'creating', a: 'created', campi: CREATED }, 'fase-diversa'],
    [{ launchId: 'non-hex', da: 'prepared', a: 'creating' }, 'argomenti'],
  ];
  for (const [args, codice] of rifiuti) {
    const r = lt.avanza(w.root, SESSIONE, args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(r.codice, codice, JSON.stringify(args));
    assert.equal(fs.readFileSync(w.file, 'utf8'), prima, 'un avanzamento rifiutato non tocca il disco');
  }
  // La fase non torna indietro nemmeno dopo averla raggiunta.
  assert.ok(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).ok);
  const r = lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' });
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'fase-diversa');
});

test('i campi di una fase sono chiusi: mancanti, estranei o fuori forma rifiutano', (t) => {
  const w = mondo(t);
  prepara(w);
  lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' });
  const prima = fs.readFileSync(w.file, 'utf8');
  const cattivi = [
    {},
    { sessionId: '$5', windowId: '@7' },
    { ...CREATED, paneId: '%x' },
    { ...CREATED, sessionId: '5' },
    { ...CREATED, windowId: '%7' },
    { ...CREATED, panePid: 2222 },
    { ...CREATED, holdPid: 0 },
    { ...CREATED, holdStarttime: 'x' },
    { ...CREATED, phase: 'attested' },
  ];
  for (const campi of cattivi) {
    const r = lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'created', campi });
    assert.equal(r.ok, false, JSON.stringify(campi));
    assert.equal(r.codice, 'campi', JSON.stringify(campi));
    assert.equal(fs.readFileSync(w.file, 'utf8'), prima);
  }
});

test('abort: stato terminale raggiungibile solo da prepared/creating, con motivo dichiarato', (t) => {
  const w = mondo(t);
  prepara(w);
  lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' });
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'aborted' }).codice, 'campi',
    'senza motivo');
  assert.equal(lt.avanza(w.root, SESSIONE, {
    launchId: LAUNCH, da: 'creating', a: 'aborted', campi: { abortReason: 'qualcosa' },
  }).codice, 'campi', 'motivo fuori dall\'insieme chiuso');
  assert.ok(lt.avanza(w.root, SESSIONE, {
    launchId: LAUNCH, da: 'creating', a: 'aborted', campi: { abortReason: 'duplicate-session' },
  }).ok);
  const r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.record.phase, 'aborted');
  assert.equal(r.record.abortReason, 'duplicate-session');
  assert.equal(r.record.incerto, true, 'un lancio abortito resta bloccante finche\' qualcuno non lo chiude');
  assert.equal(r.record.qualificato, true);
  // Terminale: non si riparte ne' si avanza.
  for (const a of ['creating', 'created', 'attested']) {
    assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'aborted', a, campi: CREATED }).codice, 'transizione');
  }
  // E da created in poi l'abort non esiste: una sessione puo' essere nata.
  const w2 = mondo(t);
  prepara(w2);
  lt.avanza(w2.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' });
  lt.avanza(w2.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'created', campi: CREATED });
  assert.equal(lt.avanza(w2.root, SESSIONE, {
    launchId: LAUNCH, da: 'created', a: 'aborted', campi: { abortReason: 'duplicate-session' },
  }).codice, 'transizione');
});

test('prepared per vl porta owner e root canonica; forme fuori dal chiuso rifiutano prima del disco', (t) => {
  const w = mondo(t);
  const ok = lt.registraPrepared(w.root, SESSIONE, {
    launchId: LAUNCH, family: 'vl', cellId: 'Giornale', ownerInstanceId: OWNER, tmuxSocket: '/tmp/nc-sock',
    daemonInc: 'inc-1', res: { vlOwner: OWNER, vlRoot: '/home/x/.local/state/vl/host-v1' },
  });
  assert.deepStrictEqual(ok, { ok: true });
  const r = lt.leggi(w.root, SESSIONE).record;
  assert.equal(r.family, 'vl');
  assert.deepStrictEqual(r.res, { vlOwner: OWNER, vlRoot: '/home/x/.local/state/vl/host-v1' });
  assert.equal(r.bootId, null, 'boot id illeggibile: il lancio parte, la prova di boot e\' spenta');
  assert.equal(r.qualificato, true);

  const w2 = mondo(t);
  const base = { launchId: LAUNCH, cellId: 'Giornale', tmuxSocket: '/tmp/nc-sock', daemonInc: 'inc-1' };
  const cattivi = [
    { ...base, family: 'vl' },
    { ...base, family: 'vl', ownerInstanceId: OWNER, res: { vlOwner: OWNER, vlRoot: 'relativo' } },
    { ...base, family: 'vl', ownerInstanceId: OWNER, res: { vlOwner: 'xx', vlRoot: '/abs' } },
    { ...base, family: 'vl', ownerInstanceId: ALTRO, res: { vlOwner: OWNER, vlRoot: '/abs' } },
    { ...base, family: 'other', res: { vlOwner: OWNER, vlRoot: '/abs' } },
    { ...base, family: 'altra' },
    { ...base, family: 'other', tmuxSocket: 'relativo' },
    { ...base, family: 'other', bootId: 'non-uuid' },
    { ...base, family: 'other', launchId: 'zz' },
    { ...base, family: 'other', daemonInc: '' },
    { ...base, family: 'other', cellId: '' },
  ];
  for (const dati of cattivi) {
    const esito = lt.registraPrepared(w2.root, SESSIONE, dati);
    assert.equal(esito.ok, false, JSON.stringify(dati));
    assert.equal(esito.pubblicato, 'no');
  }
  assert.equal(lt.leggi(w2.root, SESSIONE).stato, 'assente', 'nessun file dopo i rifiuti');
  assert.equal(fs.existsSync(path.join(w2.root, 'launch-targets')), false, 'nemmeno la directory');
});

test('lettura v1 invariata: nessuna fase inventata, nessun falso qualificato', (t) => {
  const w = mondo(t);
  // Intent v1: gli id sono i falsi $0/%0 e restano tali per chi li legge.
  assert.equal(lt.registraIntent(w.root, SESSIONE, { launchId: LAUNCH, family: 'vl', tmuxSocket: '/tmp/s', ora: 5 }), true);
  let r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.stato, 'presente');
  assert.equal(r.record.version, 1);
  assert.equal(r.record.phase, null);
  assert.equal(r.record.sessionId, '$0');
  assert.equal(r.record.incerto, true);
  // v1 completo: stessi campi di sempre.
  assert.equal(lt.registra(w.root, SESSIONE, {
    launchId: LAUNCH, sessionId: '$5', paneId: '%9', tmuxSocket: '/tmp/s', serverPid: 4242,
    panePid: 2222, paneStarttime: 999, family: 'other', ora: 6,
  }), true);
  r = lt.leggi(w.root, SESSIONE);
  assert.equal(r.record.version, 1);
  assert.equal(r.record.phase, null);
  assert.equal(r.record.panePid, 2222);
  assert.equal(r.record.paneStarttime, 999);
  assert.equal(r.record.incerto, false);
  // Un v1 non si avanza ne' si riscrive come v2.
  const prima = fs.readFileSync(w.file, 'utf8');
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).codice, 'legacy');
  assert.equal(fs.readFileSync(w.file, 'utf8'), prima);
});

test('fase invalida, versione ignota o chiave diversa: indeterminato, mai interpretato', (t) => {
  const w = mondo(t);
  prepara(w);
  const base = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  const scrivi = (o) => fs.writeFileSync(w.file, JSON.stringify(o));
  const indeterminati = [
    { ...base, phase: 'finita' },
    { ...base, phase: null },
    { ...base, phase: undefined },
    { ...base, version: 3 },
    { ...base, version: '2' },
    { ...base, launchId: 'zz' },
    { ...base, family: 'altra' },
    { ...base, session: 'cloud-Altra' },
  ];
  for (const dato of indeterminati) {
    scrivi(dato);
    assert.equal(lt.leggi(w.root, SESSIONE).stato, 'indeterminato', JSON.stringify(dato));
    const a = lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' });
    assert.equal(a.ok, false);
  }
});

test('dati obbligatori di una fase mancanti: presente ma NON qualificato, sempre incerto', (t) => {
  const w = mondo(t);
  percorsoCompleto(w);
  const completo = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  const scrivi = (o) => fs.writeFileSync(w.file, JSON.stringify(o));
  const guasti = [
    ['created senza windowId', { ...completo, phase: 'created', panePid: undefined, paneStarttime: undefined, windowId: undefined }],
    ['created con il pid del supervisore', { ...completo, phase: 'created' }],
    ['prepared con id veri', { ...completo, phase: 'prepared', panePid: undefined, paneStarttime: undefined }],
    ['creating con falso $0', { ...completo, phase: 'creating', sessionId: '$0', paneId: '%0', windowId: undefined, panePid: undefined, paneStarttime: undefined }],
    ['attested con nascita senza pid', { ...completo, panePid: undefined }],
    ['senza demone', { ...completo, daemonInc: undefined }],
    ['senza cella', { ...completo, cellId: undefined }],
    ['socket relativo', { ...completo, tmuxSocket: 'rel' }],
    ['boot id malformato', { ...completo, bootId: 'x' }],
    ['aborted senza motivo', { ...completo, phase: 'aborted', sessionId: undefined, windowId: undefined, paneId: undefined, panePid: undefined, paneStarttime: undefined }],
  ];
  for (const [nome, dato] of guasti) {
    scrivi(dato);
    const r = lt.leggi(w.root, SESSIONE);
    assert.equal(r.stato, 'presente', nome);
    assert.equal(r.record.qualificato, false, nome);
    assert.equal(r.record.incerto, true, nome);
  }
  // Un v2 non qualificato non avanza.
  scrivi({ ...completo, phase: 'prepared', sessionId: '$5' });
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).codice, 'non-qualificato');
  // vl: res mancante o incoerente con l'owner.
  const vl = mondo(t);
  lt.registraPrepared(vl.root, SESSIONE, {
    launchId: LAUNCH, family: 'vl', cellId: 'G', ownerInstanceId: OWNER, tmuxSocket: '/tmp/s', daemonInc: 'i',
    res: { vlOwner: OWNER, vlRoot: '/r' },
  });
  const dv = JSON.parse(fs.readFileSync(vl.file, 'utf8'));
  for (const guasto of [{ ...dv, res: null }, { ...dv, res: { vlOwner: ALTRO.repeat(2), vlRoot: '/r' } }, { ...dv, ownerInstanceId: null }]) {
    fs.writeFileSync(vl.file, JSON.stringify(guasto));
    assert.equal(lt.leggi(vl.root, SESSIONE).record.qualificato, false);
  }
});

test('record assente, illeggibile o di un altro lancio: avanza e rimuoviDelLancio non indovinano', (t) => {
  const w = mondo(t);
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).codice, 'assente');
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH), true, 'assenza = successo');
  prepara(w);
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, ALTRO), false, 'un altro lancio non si tocca');
  assert.ok(fs.existsSync(w.file));
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, 'non-hex'), false);
  fs.writeFileSync(w.file, '{ non json');
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).codice, 'illeggibile');
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH), false, 'illeggibile: non si cancella');
  assert.ok(fs.existsSync(w.file));
  fs.writeFileSync(w.file, JSON.stringify({ launchId: LAUNCH, version: 2, phase: 'prepared' }));
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH), true, 'stesso lancio: si toglie');
  assert.equal(fs.existsSync(w.file), false);
});

// --- Guasti di scrittura, uno per punto -------------------------------------
// fs avvolto dal lato del test: il modulo chiama fs.<fn> per proprieta', quindi
// l'iniezione lo raggiunge senza nessun punto di guasto nel codice di
// produzione. Le chiamate di fsync sono nell'ordine: file temporaneo, poi le
// directory della catena (la prima e' la directory dei record).

function conGuasto(fn, quando, eseguito) {
  const originale = fs[fn];
  let n = 0;
  fs[fn] = function guasta(...args) {
    n += 1;
    if (quando(n, args)) throw Object.assign(new Error(`guasto iniettato in ${fn}`), { code: 'EIO' });
    return originale.apply(this, args);
  };
  try { return eseguito(); } finally { fs[fn] = originale; }
}

function stato(w) {
  return fs.existsSync(w.file) ? fs.readFileSync(w.file, 'utf8') : null;
}

const PUNTI = [
  ['openSync del temporaneo', 'openSync', (n, a) => typeof a[0] === 'string' && a[0].endsWith('.tmp'), 'no'],
  ['writeFileSync', 'writeFileSync', () => true, 'no'],
  ['fsync del file temporaneo', 'fsyncSync', (n) => n === 1, 'no'],
  ['rename', 'renameSync', () => true, 'no'],
  ['fsync della directory dopo il rename', 'fsyncSync', (n) => n === 2, 'incerto'],
];

for (const [nome, fn, quando, atteso] of PUNTI) {
  test(`guasto in «${nome}»: avanza dichiara lo stadio e non promette il vecchio record`, (t) => {
    const w = mondo(t);
    prepara(w);
    const prima = stato(w);
    const r = conGuasto(fn, quando, () => lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }));
    assert.equal(r.ok, false);
    assert.equal(r.codice, 'scrittura');
    assert.equal(r.pubblicato, atteso);
    const dopo = stato(w);
    const letto = lt.leggi(w.root, SESSIONE);
    assert.equal(letto.stato, 'presente', 'mai un file a meta\'');
    if (atteso === 'no') {
      assert.equal(dopo, prima, 'prima del rename il record precedente e\' intatto');
    } else {
      assert.equal(letto.record.phase, 'creating', 'dopo il rename la fase nuova e\' gia\' visibile');
    }
    // Nessun temporaneo orfano.
    const orfani = fs.readdirSync(path.join(w.root, 'launch-targets')).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(orfani, []);
  });

  test(`guasto in «${nome}»: registraPrepared dichiara lo stadio`, (t) => {
    const w = mondo(t);
    const r = conGuasto(fn, quando, () => prepara(w));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'scrittura');
    assert.equal(r.pubblicato, atteso);
    assert.equal(lt.leggi(w.root, SESSIONE).stato, atteso === 'no' ? 'assente' : 'presente');
  });
}

test('dopo un guasto incerto il passo successivo parte dalla fase che il disco dice', (t) => {
  const w = mondo(t);
  prepara(w);
  conGuasto('fsyncSync', (n) => n === 2, () => lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }));
  // Chi ritenta con la fase vecchia non puo' riscrivere: il disco e' gia' avanti.
  assert.equal(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }).codice, 'fase-diversa');
  assert.ok(lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'creating', a: 'created', campi: CREATED }).ok);
});

test('rimuoviDelLancio: unlink fallito o fsync fallito non dichiarano la rimozione', (t) => {
  const w = mondo(t);
  prepara(w);
  assert.equal(conGuasto('unlinkSync', () => true, () => lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH)), false);
  assert.ok(fs.existsSync(w.file));
  assert.equal(conGuasto('fsyncSync', () => true, () => lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH)), false,
    'unlink fatto ma directory non sincronizzata: rimozione non provata');
  assert.equal(lt.rimuoviDelLancio(w.root, SESSIONE, LAUNCH), true);
});

test('un lettore non vede mai un file a meta\' durante una scrittura', (t) => {
  const w = mondo(t);
  prepara(w);
  // Lettura "nel mezzo": dentro writeFileSync del temporaneo il file definitivo e' ancora quello vecchio intero.
  const originale = fs.writeFileSync;
  let visto = null;
  fs.writeFileSync = function osserva(...args) {
    if (visto === null) visto = lt.leggi(w.root, SESSIONE);
    return originale.apply(this, args);
  };
  try { lt.avanza(w.root, SESSIONE, { launchId: LAUNCH, da: 'prepared', a: 'creating' }); } finally { fs.writeFileSync = originale; }
  assert.equal(visto.stato, 'presente');
  assert.equal(visto.record.phase, 'prepared');
  assert.equal(lt.leggi(w.root, SESSIONE).record.phase, 'creating');
});
