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

test('resolvePiComposer: which non trova nulla (throw, come il binario reale quando assente) -> not-installed', async () => {
  const r = await resolvePiComposer({ which: () => { throw new Error('which: no pi in PATH'); } });
  assert.equal(r.status, 'not-installed');
});

test('resolvePiComposer: which restituisce stringa vuota -> not-installed', async () => {
  const r = await resolvePiComposer({ which: () => '' });
  assert.equal(r.status, 'not-installed');
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

// --- requirePiComposer: skip SOLO per not-installed, throw per broken -----

test('requirePiComposer: not-installed -> skip motivato (dice COSA non e\' stato verificato), ritorna null', async () => {
  const { t, calls } = fakeT();
  const r = await requirePiComposer(t, { which: () => '' });
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
