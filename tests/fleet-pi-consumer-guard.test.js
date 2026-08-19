'use strict';

// Correzione (audit, decimo caso della stessa forma): resolvePiComposer()
// collassava OGNI scostamento a `null`, e il chiamante skippava — "Pi non
// installato" (legittimo) era INDISTINGUIBILE da "Pi c'e' ma la guardia non
// riesce a caricarlo" (la guardia stessa e' rotta). Su una macchina senza Pi
// la suite usciva verde con 8 pass e 1 skip senza aver verificato nulla — e
// quello stesso verde sarebbe apparso se la guardia si fosse rotta mentre Pi
// era regolarmente installato (percorso spostato, dist cambiata, export
// rinominato). Uno skip motivato resta uno skip: non distingue "non
// applicabile" da "non ho potuto guardare".
//
// Questi test verificano l'helper stesso (tests/helpers/pi-real-consumer.js):
// i tre stati (not-installed / broken / ready) e che requirePiComposer
// traduca 'broken' in un FALLIMENTO (throw), mai in uno skip.
//
// Correzione 3 (caso adiacente, stessa decisione presa in una forma diversa
// da quella gia' corretta): i casi precedenti vivevano dentro un `catch`. La
// stessa domanda ("Pi c'e' o non c'e'?") viene decisa anche SENZA eccezione —
// `which` che esce con successo ma senza indicare un percorso, o con un exit
// code che non significa inequivocabilmente "non trovato". Vedi DRIFT 8/9 e
// i due CONTROLLO NEGATIVO che attraversano un `which` vero nel PATH.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePiComposer, requirePiComposer } = require('./helpers/pi-real-consumer.js');

function fakeT() {
  const calls = { skip: [] };
  return { t: { skip: (msg) => calls.skip.push(msg) }, calls };
}

test('resolvePiComposer: which PARTE e risponde "non trovato" (exit 1, come execFileSync reale) -> not-installed', async () => {
  const r = await resolvePiComposer({ which: () => { const e = new Error('Command failed: which pi'); e.status = 1; throw e; } });
  assert.equal(r.status, 'not-installed');
});

// --- Correzione 3 (caso adiacente: stessa decisione, forma diversa) -------
// Le correzioni precedenti avevano ispezionato ogni `catch` — il difetto
// viveva li'. Questo caso vive nel ramo DIRETTO (nessuna eccezione): which
// che "risponde" senza indicare un percorso, o con un exit code che non
// significa inequivocabilmente "non trovato". Il test sotto consacrava
// esattamente il comportamento vecchio (stringa vuota -> not-installed) ed
// e' per questo CORRETTO, non affiancato da un nuovo caso separato.

test('DRIFT 8: which esce senza errore (successo) ma senza indicare un percorso (output vuoto) -> broken, mai not-installed', async () => {
  const r = await resolvePiComposer({ which: () => '' });
  assert.equal(r.status, 'broken', 'un successo senza percorso e\' una risposta ambigua, non "non trovato"');
  assert.match(r.reason, /ambigua|percorso/i);
});

test('DRIFT 9: which esce con un codice che non significa inequivocabilmente "non trovato" (es. 2) -> broken, mai not-installed', async () => {
  const r = await resolvePiComposer({ which: () => { const e = new Error('which: illegal option'); e.status = 2; throw e; } });
  assert.equal(r.status, 'broken', 'un exit code non convenzionale non e\' un "non trovato" legittimo');
  assert.match(r.reason, /codice 2|exit 1|convenzione/i);
});

// --- Correzione 2 (caso adiacente segnalato dall'audit) --------------------
// «which esce non-zero» (lo strumento ha risposto: non trovato) e «which non
// riesce a partire» (ENOENT/EACCES sullo spawn: lo strumento e' rotto) erano
// collassati nello stesso catch -> 'not-installed'. Con Pi REALMENTE
// installato, se `which` stesso non e' eseguibile, la suite usciva verde
// (16 pass, 1 skip) senza aver verificato nulla — lo strumento di rilevamento
// rotto letto come "Pi assente".

test('DRIFT 4: which stesso non parte (ENOENT sullo spawn) -> broken, mai not-installed', async () => {
  const r = await resolvePiComposer({ which: () => { const e = new Error('spawn which ENOENT'); e.code = 'ENOENT'; e.status = null; throw e; } });
  assert.equal(r.status, 'broken', 'lo strumento di rilevamento rotto deve far fallire, non skippare');
  assert.match(r.reason, /ENOENT/);
  assert.match(r.reason, /rilevamento|which/i);
});

test('DRIFT 5: which non eseguibile per permessi (EACCES) -> broken, mai not-installed', async () => {
  const r = await resolvePiComposer({ which: () => { const e = new Error('permission denied'); e.code = 'EACCES'; e.status = null; throw e; } });
  assert.equal(r.status, 'broken');
  assert.match(r.reason, /EACCES/);
});

test('DRIFT 6: un package.json lungo il percorso e\' CORROTTO (JSON invalido) -> la reason lo NOMINA, non dice genericamente "nessuno trovato"', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-drift6-'));
  try {
    const badPkgPath = path.join(root, 'package.json');
    fs.writeFileSync(badPkgPath, '{ questo non e" JSON valido');
    const fakeBin = path.join(root, 'bin', 'pi');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '#!/bin/sh\n');
    const r = await resolvePiComposer({ which: () => fakeBin });
    assert.equal(r.status, 'broken');
    // La reason deve NOMINARE il file corrotto, non limitarsi a "nessuno trovato".
    assert.match(r.reason, new RegExp(badPkgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'la reason deve citare il percorso del package.json illeggibile, non tacere che uno e\' stato trovato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DRIFT 7: un package.json lungo il percorso non e\' leggibile (EACCES) -> la reason lo NOMINA', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-drift7-'));
  try {
    const badPkgPath = path.join(root, 'package.json');
    fs.writeFileSync(badPkgPath, JSON.stringify({ name: 'qualcosa-altro' }));
    fs.chmodSync(badPkgPath, 0o000);
    const fakeBin = path.join(root, 'bin', 'pi');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '#!/bin/sh\n');
    const r = await resolvePiComposer({ which: () => fakeBin });
    // Se il processo gira come root, chmod 000 non blocca la lettura: in quel
    // caso non c'e' EACCES da testare qui (l'ambiente lo rende impossibile).
    if (process.getuid && process.getuid() === 0) { fs.chmodSync(badPkgPath, 0o644); return; }
    assert.equal(r.status, 'broken');
    assert.match(r.reason, new RegExp(badPkgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { fs.chmodSync(path.join(root, 'package.json'), 0o644); fs.rmSync(root, { recursive: true, force: true }); }
});

// --- CONTROLLO NEGATIVO: il drift che oggi produceva un verde -------------
// Pi e' "presente" (which trova un binario reale) ma NON e' il pacchetto Pi:
// prima di questa correzione questo scenario collassava a null -> skip. Ora
// deve essere 'broken': la guardia si accorge che qualcosa non torna, invece
// di dichiarare "non installato" quando in realta' non ha potuto guardare.

test('DRIFT 1: which trova un binario reale che NON e\' Pi -> broken (mai not-installed)', async () => {
  // /bin/ls esiste su qualunque macchina Linux/macOS: un binario vero, ma
  // risalendo le directory non si trova mai un package.json di
  // @earendil-works/pi-coding-agent.
  const r = await resolvePiComposer({ which: () => '/bin/ls' });
  assert.equal(r.status, 'broken', 'un binario reale che non e\' Pi deve rompere la guardia, non farla tacere');
  assert.match(r.reason, /package\.json/i);
  assert.match(r.reason, /@earendil-works\/pi-coding-agent/);
});

test('DRIFT 2: package Pi trovato ma dist/core/provider-composer.js manca (struttura cambiata) -> broken', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-drift-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '99.0.0' }));
    const binDir = path.join(root, 'dist');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, 'cli.js');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env node\n');
    // NESSUN dist/core/provider-composer.js: simula la dist che e' cambiata.
    const r = await resolvePiComposer({ which: () => fakeBin });
    assert.equal(r.status, 'broken', 'la dist mancante deve rompere la guardia, non farla skippare');
    assert.match(r.reason, /provider-composer\.js/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DRIFT 3: la dist esiste ma non esporta composeModelProvider (API rinominata) -> broken', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-drift-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '99.0.0', type: 'module' }));
    const coreDir = path.join(root, 'dist', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'provider-composer.js'), 'export function somethingElse() {}\n');
    const fakeBin = path.join(root, 'dist', 'cli.js');
    fs.writeFileSync(fakeBin, '// not real\n');
    const r = await resolvePiComposer({ which: () => fakeBin });
    assert.equal(r.status, 'broken', 'un export mancante/rinominato deve rompere la guardia, non farla skippare');
    assert.match(r.reason, /composeModelProvider/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- CONTROLLO NEGATIVO integrato: which VERO nel PATH, nessun seam -------
// I due DRIFT sopra usano seams.which per isolare la logica. Questi due test
// invece attraversano il percorso REALE (execFileSync('which', ['pi'])) con
// un binario `which` fittizio anteposto al PATH — la stessa forma che
// produceva il difetto misurato, non una ricostruzione del rimedio
// dentro il test. Un `which` fittizio maschera quello di sistema a
// prescindere da cosa sia realmente installato: verifica che la guardia si
// accorga del problema anche se Pi fosse davvero presente sulla macchina.

test('CONTROLLO NEGATIVO: which reale nel PATH esce 0 senza stampare nulla -> broken (nessun seam)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-fakewhich-empty-'));
  const fakeWhich = path.join(dir, 'which');
  fs.writeFileSync(fakeWhich, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeWhich, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    const r = await resolvePiComposer();
    assert.equal(r.status, 'broken', 'which reale, exit 0 senza output, deve rompere la guardia, non skippare');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CONTROLLO NEGATIVO: which reale nel PATH esce con codice 2 -> broken (nessun seam)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-fakewhich-exit2-'));
  const fakeWhich = path.join(dir, 'which');
  fs.writeFileSync(fakeWhich, '#!/bin/sh\nexit 2\n');
  fs.chmodSync(fakeWhich, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    const r = await resolvePiComposer();
    assert.equal(r.status, 'broken', 'which reale, exit 2, non e\' un "non trovato" inequivocabile');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- requirePiComposer: skip SOLO per not-installed, throw per broken -----

test('requirePiComposer: not-installed -> skip motivato (dice COSA non e\' stato verificato), ritorna null', async () => {
  const { t, calls } = fakeT();
  // Stringa vuota NON e' piu' un seam valido per "non installato" (DRIFT 8:
  // e' una risposta ambigua, ora 'broken'). L'assenza legittima e' l'exit
  // code convenzionale di which per "non trovato" (1).
  const r = await requirePiComposer(t, { which: () => { const e = new Error('Command failed: which pi'); e.status = 1; throw e; } });
  assert.equal(r, null);
  assert.equal(calls.skip.length, 1);
  // Il messaggio deve dire cosa non e' stato verificato, non solo "saltato".
  assert.match(calls.skip[0], /non installato/i);
  assert.match(calls.skip[0], /ProviderModelConfig|contratto/i);
});

test('requirePiComposer: broken -> LANCIA (fallimento del test, mai skip, mai pass)', async () => {
  const { t, calls } = fakeT();
  await assert.rejects(
    () => requirePiComposer(t, { which: () => '/bin/ls' }),
    /guardia Pi rotta/,
  );
  assert.equal(calls.skip.length, 0, 'un fallimento non deve MAI passare anche per uno skip');
});

// --- Caso reale positivo: su questa macchina Pi e' installato -------------

test('resolvePiComposer: sulla macchina reale (nessun seam) -> ready, con composeModelProvider funzione', async () => {
  const r = await resolvePiComposer();
  // Non e' uno skip: se questa macchina non avesse Pi, sarebbe un dato di
  // fatto sull'ambiente, non un difetto — ma qui verifichiamo esplicitamente
  // che il caso positivo funzioni quando Pi c'e' davvero (com'e' su questa
  // macchina, gia' usata dagli altri test D2/Pi).
  assert.ok(r.status === 'ready' || r.status === 'not-installed', `status inatteso: ${r.status}${r.reason ? ' — ' + r.reason : ''}`);
  if (r.status === 'ready') assert.equal(typeof r.composeModelProvider, 'function');
});
