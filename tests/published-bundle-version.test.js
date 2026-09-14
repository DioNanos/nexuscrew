// tests/published-bundle-version.test.js — il pacchetto non deve poter
// spedire un bundle cablato con una versione diversa da quella che annuncia.
//
// PERCHE' E' UN TEST E NON UNA NOTA DI RELEASE. La `frontend/dist/` e'
// COMMITTATA: il pacchetto spedisce un bundle precompilato, e la versione del
// browser (`__NC_BUILD_VERSION__`, iniettata da `frontend/vite.config.js` dal
// `package.json` AL MOMENTO DEL BUILD) e' una stringa dentro quell'asset. Il
// bump di release invece tocca `frontend/dist/version.json`, che il server
// legge da disco e serve come `uiVersion` in `/api/config`. Se il bump non
// ricostruisce il bundle, i due valori divergono: `uiVersion !==
// browserVersion` in `frontend/src/lib/sw-update.js`, banner di aggiornamento
// che annuncia la versione gia' in esecuzione, `location.reload()` che ricarica
// lo stesso bundle, e la guardia anti-loop che spegne il ricaricamento
// automatico lasciando il banner acceso per sempre.
//
// E' RECIDIVA, non un incidente: 0.9.21, 0.9.23 («stale-dist update banner»,
// ricostruito a mano) e 0.9.25 (bump di `version.json` senza rebuild, bundle
// rimasto 0.9.24: il banner e' tornato sull'app del telefono). Una checklist
// scritta a mano copre cio' che ricordi: questo gate copre cio' che c'e' nel
// tree, e fallisce prima del publish invece che dopo — npm non si ripubblica.
//
// COSA NON PROVA: che il bundle sia aggiornato nel CONTENUTO. Prova l'unica
// cosa che si puo' provare senza ricompilare: che la versione cablata
// nell'asset spedito sia quella dichiarata. Un `frontend/src` piu' nuovo del
// dist non e' visibile da qui.
// Nota: escluso dalla superficie pubblica come i gate accanto (vedi
// `publish/git-surface-exclude.txt`): parla di come si pubblica, non del
// prodotto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const INDEX = path.join(DIST, 'index.html');

// Una versione semantica, QUALUNQUE sia la linea di release corrente. La prima
// versione di questo gate cercava `0.9.x`, che era la linea di allora: sarebbe
// andato in silenzio al primo 0.10.0, cioe' proprio quando un gate silenzioso
// costa di piu'. La linea non si scrive qui: si legge dal `package.json`.
const PROD_VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

// Le versioni DELLA LINEA DEL PRODOTTO dentro il bundle: stesso major.minor del
// pacchetto. Nel bundle ci sono anche le versioni delle dipendenze (react
// 18.3.1, ...) e numeri che sembrano versioni senza esserlo (127.0.0,
// 172.17.0): filtrare sulla linea del pacchetto e' cio' che rende l'asserzione
// "solo la versione nuova" invece di "almeno la versione nuova".
function productLineRe(pkg) {
  const [major, minor] = String(pkg).split('.');
  return new RegExp(`^${major}\\.${minor}\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageVersion() {
  return readJson(path.join(ROOT, 'package.json')).version;
}

function uiVersion() {
  return readJson(path.join(DIST, 'version.json')).version;
}

// Il bundle che il browser esegue davvero e' quello REFERENZIATO da
// index.html, non "tutti i .js in assets/": un worker o un asset orfano non
// decide quale codice gira nella pagina. Prendere la referenza da index.html
// e' anche l'unico modo che non va aggiornato a mano quando il nome hashato
// del bundle cambia.
function bundlesFromIndex() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/g)]
    .map((m) => m[1]);
  return [...new Set(refs)].map((rel) => {
    const file = path.join(DIST, rel);
    return { rel, file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  });
}

function bakedVersions(bundles) {
  const found = new Set();
  for (const bundle of bundles) {
    if (!bundle.text) continue;
    const re = new RegExp(PROD_VERSION_RE.source, PROD_VERSION_RE.flags);
    for (const m of bundle.text.match(re) || []) found.add(m);
  }
  return [...found].sort();
}

// Il gate come funzione PURA dei suoi tre ingressi: la versione dichiarata dal
// pacchetto, quella servita da disco e il testo degli asset referenziati da
// index.html. Pura per una ragione precisa: i casi che servono una linea di
// release diversa (0.10.0) o un bundle stantio non devono ricostruire il
// frontend per essere provati — un gate che si puo' provare solo ricompilando
// e' un gate che si smette di provare.
function bundleProblems(pkg, ui, bundles) {
  const problems = [];
  if (ui !== pkg) {
    problems.push(`frontend/dist/version.json dice ${ui}, package.json dice ${pkg}: `
      + 'il bump di release ha toccato solo uno dei due (npm non si ripubblica)');
  }
  if (bundles.length < 1) {
    problems.push(`index.html non referenzia nessun assets/*.js: ${INDEX} non e' un dist valido`);
  }
  for (const bundle of bundles) {
    if (!bundle.text) {
      problems.push(`index.html referenzia ${bundle.rel} che non esiste nel dist`);
    }
  }
  const cablate = bakedVersions(bundles);
  if (!cablate.includes(pkg)) {
    problems.push(`nessuno degli asset referenziati da index.html cabla "${pkg}": `
      + `trovate ${JSON.stringify(cablate)}. Il bundle e' stato costruito da un `
      + "package.json piu' vecchio del bump: va ricostruito (`npm run build`) "
      + 'e committato, altrimenti la UI mostra un banner di aggiornamento perpetuo');
  }
  const linea = cablate.filter((v) => productLineRe(pkg).test(v));
  if (JSON.stringify(linea) !== JSON.stringify([pkg])) {
    problems.push(`nella linea ${pkg.split('.').slice(0, 2).join('.')} degli asset `
      + `referenziati da index.html ci sono versioni di prodotto diverse da quella `
      + `spedita: ${JSON.stringify(linea)} != [${JSON.stringify(pkg)}]`);
  }
  return problems;
}

test('gate: la versione del pacchetto coincide con la uiVersion servita da disco', () => {
  const problems = bundleProblems(packageVersion(), uiVersion(), bundlesFromIndex());
  assert.deepEqual(problems, []);
});

test('gate: il bundle spedito cabla la stessa versione di package.json', () => {
  const pkg = packageVersion();
  const bundles = bundlesFromIndex();
  assert.ok(bundles.length >= 1,
    `index.html non referenzia nessun assets/*.js: ${INDEX} non e' un dist valido`);
  for (const bundle of bundles) {
    assert.ok(bundle.text, `index.html referenzia ${bundle.rel} che non esiste nel dist`);
  }
  const cablate = bakedVersions(bundles);
  assert.ok(cablate.includes(pkg),
    `nessuno degli asset referenziati da index.html cabla "${pkg}": `
    + `trovate ${JSON.stringify(cablate)}. Il bundle e' stato costruito da un `
    + 'package.json piu' + "' vecchio del bump: va ricostruito (`npm run build`) "
    + 'e committato, altrimenti la UI mostra un banner di aggiornamento perpetuo');
  const linea = cablate.filter((v) => productLineRe(pkg).test(v));
  assert.deepEqual(linea, [pkg],
    `nella linea ${pkg.split('.').slice(0, 2).join('.')} degli asset referenziati da `
    + `index.html ci sono versioni di prodotto diverse da quella spedita: `
    + `${JSON.stringify(linea)} != ["${pkg}"]`);
});

test('gate: una release 0.10.0 passa senza toccare questo file', () => {
  // Il bundle delle dipendenze contiene anche versioni che sembrano di prodotto:
  // il gate deve restare preciso su una linea diversa da quella di allora.
  const bundle = {
    rel: 'assets/index-finto.js',
    text: 'const VERSION="0.10.0";/* react 18.3.1 */ const host="127.0.0";',
  };
  assert.deepEqual(bundleProblems('0.10.0', '0.10.0', [bundle]), []);
});

test('gate: un bundle costruito da un package.json piu\' vecchio fa fallire il gate', () => {
  const stantio = { rel: 'assets/index-finto.js', text: 'const VERSION="0.9.24";' };
  const problems = bundleProblems('0.10.0', '0.10.0', [stantio]);
  assert.ok(problems.length >= 1, 'un bundle stantio deve produrre almeno un problema');
  assert.ok(problems.some((p) => p.includes('0.10.0')),
    `il problema deve nominare la versione attesa: ${JSON.stringify(problems)}`);
});

test('gate: un version.json non ricostruito fa fallire il gate', () => {
  const bundle = { rel: 'assets/index-finto.js', text: 'const VERSION="0.10.0";' };
  const problems = bundleProblems('0.10.0', '0.9.26', [bundle]);
  assert.ok(problems.some((p) => p.includes('version.json')),
    `il problema deve nominare version.json: ${JSON.stringify(problems)}`);
});
