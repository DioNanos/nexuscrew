'use strict';

// D2 audit: "il consumatore vero non e' il file: e' Pi che lo legge." Un test
// che legge il file .ts generato non prova che Pi possa caricarlo — questo
// helper esegue REALMENTE il pacchetto Pi installato sulla macchina (Node 24
// esegue file .ts nativamente, e i moduli di composizione modello di Pi sono
// pura logica JS, importabili senza avviare l'intero agente).
//
// Portabile per costruzione: risolve il binario `pi` dal PATH del processo
// (mai un percorso hardcoded di una singola installazione nvm), poi risale le
// directory dal binario fino al package.json del pacchetto
// @earendil-works/pi-coding-agent.
//
// Correzione (audit): resolvePiComposer() prima collassava OGNI scostamento a
// `null`, e il chiamante skippava — indistintamente per "Pi non installato"
// (legittimo) e per "Pi c'e' ma la guardia non riesce a caricarlo" (la guardia
// stessa e' rotta). Su una macchina senza Pi la suite usciva verde con 8 pass
// e 1 skip senza aver verificato nulla, ed era INDISTINGUIBILE da una guardia
// rotta che skippava per lo stesso motivo. Ora resolvePiComposer() ritorna uno
// status esplicito:
//   { status: 'not-installed' }                              -> skip legittimo
//   { status: 'broken', reason }                              -> FALLIMENTO, mai skip
//   { status: 'ready', composeModelProvider, root }           -> verifica normale
// Il discriminante e' `which`: se il binario `pi` non si trova affatto, e'
// assenza legittima. Se `which` lo trova ma un passo SUCCESSIVO fallisce
// (symlink rotto, package.json non e' quello atteso, la dist e' cambiata,
// l'import fallisce, l'export atteso manca), quella e' la guardia che si e'
// rotta mentre Pi era presente — un fallimento, non un'assenza.
//
// Correzione 2 (caso adiacente, stesso giorno): «which esce non-zero perche'
// pi non e' nel PATH» e «which stesso non riesce a partire» sono due errori
// diversi, ed erano collassati nello STESSO catch -> 'not-installed'. Misurato:
// se `which` (il binario di sistema) non e' eseguibile, con Pi REALMENTE
// installato la suite usciva verde con 16 pass e 1 skip — lo strumento di
// rilevamento rotto veniva letto come "Pi assente". Distinzione (verificata
// empiricamente): quando `which` PARTE e risponde (target non trovato), l'
// errore di execFileSync porta `e.status` numerico (il codice di uscita del
// processo, es. 1) e NESSUN `e.code`; quando `which` stesso non parte (ENOENT/
// EACCES sullo spawn), l'errore porta `e.code` stringa e `e.status === null`.
// Solo il primo caso e' una risposta legittima.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Ritorna { root, problems }. `root` e' la directory del pacchetto Pi, o null
// se non trovata risalendo. `problems` elenca ogni package.json incontrato
// lungo la risalita che NON era leggibile/valido per un motivo DIVERSO da
// "non esiste qui" (ENOENT e' l'unico caso legittimo di "continua a
// risalire" — un altro package.json lungo il percorso, di una dipendenza
// intermedia, e' normale). Un file che esiste ma e' illeggibile (EACCES) o
// corrotto (JSON invalido) e' un segnale reale: la reason del chiamante deve
// nominarlo, non dire genericamente "nessuno trovato" quando in realta' uno
// e' stato trovato e non ha potuto essere letto.
function findPackageRoot(fromFile) {
  let dir = path.dirname(fromFile);
  const problems = [];
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') return { root: dir, problems };
    } catch (e) {
      if (e.code !== 'ENOENT') problems.push(`"${pkgPath}": ${e.code || e.constructor.name} — ${e.message}`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: null, problems };
}

// seams.which: sostituisce la risoluzione reale di `which pi` (per il
// controllo negativo: simula un binario presente ma non un vero pacchetto Pi,
// senza toccare l'installazione reale della macchina).
async function resolvePiComposer(seams = {}) {
  const whichImpl = seams.which || (() => execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
  let which;
  try {
    which = whichImpl();
  } catch (e) {
    // Il discriminante e' CHI ha fallito, non "c'e' stata un'eccezione".
    // which PARTE e risponde "non trovato": execFileSync porta e.status
    // numerico (l'exit code del processo `which`), nessun e.code. which NON
    // parte (ENOENT/EACCES sullo spawn del comando `which` stesso — binario
    // assente, permessi, PATH corrotto): e.code e' una stringa, e.status e'
    // null. Solo il primo e' una risposta legittima di assenza; il secondo e'
    // lo strumento di rilevamento rotto — con Pi magari REALMENTE installato,
    // misurato: 16 pass e 1 skip senza aver verificato nulla.
    if (typeof e.status === 'number' && !e.code) return { status: 'not-installed' };
    return { status: 'broken', reason: `lo strumento di rilevamento (which) non e' riuscito a rispondere: ${e.code || e.constructor.name} — ${e.message}` };
  }
  if (!which) return { status: 'not-installed' };
  // Da QUI in poi il binario e' stato trovato: ogni fallimento successivo e'
  // la guardia che si rompe con Pi presente, mai piu' "non installato".
  let real;
  try {
    real = fs.realpathSync(which);
  } catch (e) {
    return { status: 'broken', reason: `which ha trovato "${which}" ma fs.realpathSync fallisce: ${e.message}` };
  }
  const { root, problems } = findPackageRoot(real);
  if (!root) {
    const detail = problems.length
      ? ` — trovati package.json non leggibili lungo il percorso: ${problems.join('; ')}`
      : '';
    return { status: 'broken', reason: `binario pi risolto a "${real}", ma nessun package.json di @earendil-works/pi-coding-agent trovato risalendo le directory${detail}` };
  }
  const composerPath = path.join(root, 'dist', 'core', 'provider-composer.js');
  if (!fs.existsSync(composerPath)) {
    return { status: 'broken', reason: `pacchetto Pi trovato in "${root}", ma manca dist/core/provider-composer.js (struttura interna cambiata?)` };
  }
  let mod;
  try {
    mod = await import(`file://${composerPath}`);
  } catch (e) {
    return { status: 'broken', reason: `import di "${composerPath}" fallito: ${e.message}` };
  }
  if (typeof mod.composeModelProvider !== 'function') {
    return { status: 'broken', reason: `"${composerPath}" importato ma non esporta composeModelProvider (API di Pi cambiata?)` };
  }
  return { status: 'ready', composeModelProvider: mod.composeModelProvider, root };
}

// Uso comune nei test: skip SOLO se legittimamente assente; se la guardia e'
// rotta (Pi presente ma non caricabile), lancia — il test FALLISCE, non passa
// ne' skippa in silenzio. Il messaggio dello skip dice COSA non e' stato
// verificato, non solo che e' stato saltato.
async function requirePiComposer(t, seams) {
  const r = await resolvePiComposer(seams);
  if (r.status === 'not-installed') {
    t.skip('Pi (@earendil-works/pi-coding-agent) non installato su questa macchina: NON verificato che i descrittori custom rispettino il contratto ProviderModelConfig di Pi (id/name/reasoning/input/cost/contextWindow/maxTokens) — il fix e\' presente nel codice ma non e\' stato attraversato da un vero consumatore in questo run');
    return null;
  }
  if (r.status === 'broken') {
    throw new Error(`guardia Pi rotta (Pi e' presente ma non caricabile), non un'assenza legittima: ${r.reason}`);
  }
  return r; // status === 'ready'
}

// Esegue REALMENTE il file .ts generato da NexusCrew (import dinamico nativo
// di Node 24) e cattura la config passata a `pi.registerProvider(id, config)`
// — esattamente cio' che Pi fa internamente quando carica un'estensione.
async function loadPiExtensionFile(tsPath) {
  const mod = await import(`file://${tsPath}`);
  let captured = null;
  await mod.default({ registerProvider: (id, config) => { captured = { id, config }; } });
  return captured;
}

module.exports = { resolvePiComposer, requirePiComposer, loadPiExtensionFile };
