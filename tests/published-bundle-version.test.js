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
// browserVersion` in `frontend/src/lib/sw-update.js`, kind `reload`, banner
// «new version {v} available» che annuncia la versione gia' in esecuzione,
// `location.reload()` che ricarica lo stesso bundle, e la guardia anti-loop
// che spegne il ricaricamento automatico lasciando il banner acceso per sempre.
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
// Le versioni che questo gate confronta sono quelle del prodotto: `0.9.x`.
// Il bundle contiene anche le versioni delle dipendenze (react 18.3.1, ...):
// filtrare su `0.9.` e' cio' che rende l'asserzione "solo la versione nuova"
// invece di "almeno la versione nuova".
const PROD_VERSION_RE = /0\.9\.\d+/g;

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
  return [...new Set(refs)].map((rel) => path.join(DIST, rel));
}

function bakedVersions(bundles) {
  const found = new Set();
  for (const file of bundles) {
    const re = new RegExp(PROD_VERSION_RE.source, PROD_VERSION_RE.flags);
    for (const m of fs.readFileSync(file, 'utf8').match(re) || []) found.add(m);
  }
  return [...found].sort();
}

test('gate: la versione del pacchetto coincide con la uiVersion servita da disco', () => {
  const pkg = packageVersion();
  const ui = uiVersion();
  assert.equal(ui, pkg,
    `frontend/dist/version.json dice ${ui}, package.json dice ${pkg}: `
    + 'il bump di release ha toccato solo uno dei due (npm non si ripubblica)');
});

test('gate: il bundle spedito cabla la stessa versione di package.json', () => {
  const pkg = packageVersion();
  const bundles = bundlesFromIndex();
  assert.ok(bundles.length >= 1,
    `index.html non referenzia nessun assets/*.js: ${INDEX} non e' un dist valido`);
  for (const file of bundles) {
    assert.ok(fs.existsSync(file),
      `index.html referenzia ${path.relative(ROOT, file)} che non esiste nel dist`);
  }
  const cablate = bakedVersions(bundles);
  assert.ok(cablate.includes(pkg),
    `nessuno degli asset referenziati da index.html cabla "${pkg}": `
    + `trovate ${JSON.stringify(cablate)}. Il bundle e' stato costruito da un `
    + 'package.json piu' + "' vecchio del bump: va ricostruito (`npm run build`) "
    + 'e committato, altrimenti la UI mostra un banner di aggiornamento perpetuo');
  assert.deepEqual(cablate, [pkg],
    `nel bundle referenziato da index.html ci sono versioni di prodotto diverse `
    + `da quella spedita: ${JSON.stringify(cablate)} != "${pkg}"`);
});
