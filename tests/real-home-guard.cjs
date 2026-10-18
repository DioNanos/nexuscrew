'use strict';

// Guardia: nessun test scrive sotto la home REALE dell'operatore.
//
// PERCHE' ESISTE, con la data. Il 18/10 un `node --test` lanciato a mano, senza
// HOME isolata, ha scritto `~/.nexuscrew/model-discovery/ollama-cloud.json`
// nella home vera di VPS3 — con dentro i modelli finti della fixture. Il file
// l'ha rimosso un umano; in produzione un file cosi' avvelena la scoperta vera,
// perche' quella cache e' la prima ricaduta della catena.
//
// La lezione non e' «ricordarsi di isolare la HOME»: e' che una dimenticanza
// deve FARE RUMORE. Qui la si fa rumore: i punti di scrittura di `fs` vengono
// avvolti e ogni percorso che cade sotto la home reale viene registrato. Il
// preload dei worker (tests/isolated-home.cjs) installa la guardia in OGNI
// processo di test, e alla fine del processo una violazione alza il codice di
// uscita: il file di test puo' anche essere verde, ma il gate rosseggia.
//
// La guardia RIFIUTA la scrittura, non la registra soltanto: la scrittura non
// avviene e il test che l'ha tentata fallisce con la causa. Registrare e
// basta non servirebbe — il file finto nella home dell'operatore resterebbe li'
// (e' quello che e' successo), e un messaggio a fine processo dipende da come il
// runner chiude i figli: il rumore deve arrivare a chi ha sbagliato, subito.
//
// Il modulo e' puro abbastanza da essere provato: `creaGuardia` accetta un
// `fsImpl` iniettato, cosi' il caso positivo si prova senza toccare il disco.

const path = require('node:path');

function sottoRadice(percorso, radice) {
  if (!percorso || !radice) return false;
  const r = radice.endsWith(path.sep) ? radice.slice(0, -1) : radice;
  return percorso === r || percorso.startsWith(`${r}${path.sep}`);
}

// Nomi che possono creare, modificare o cancellare qualcosa. `readFileSync` &
// co. non sono qui: leggere la home reale e' un difetto diverso e non e' questo.
const NOMI_CHE_SCRIVONO = Object.freeze([
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync',
  'unlinkSync', 'renameSync', 'chmodSync', 'copyFileSync', 'createWriteStream',
]);

// QUALE home e' quella "reale". Non basta `process.env.HOME`: nel gate la HOME
// del processo e' gia' quella di prova, e il runner la sovrascrive ancora. La
// home dell'OPERATORE la dice il sistema, non l'ambiente: `os.userInfo().homedir`
// resta giusta anche quando HOME punta altrove. (Se il sistema non risponde si
// ricade su HOME: meglio una guardia approssimativa che nessuna guardia.)
//
// LE ECCEZIONI, dichiarate. Dentro la home reale vive anche il CHECKOUT su cui
// si lavora: un test che scrive una fixture nel proprio worktree e' legittimo, e
// una guardia che rifiutasse anche quello sarebbe rotta. Quindi la protezione
// copre la home reale TRANNE l'albero del checkout (la cwd di partenza e la sua
// radice git), che e' l'unica parte della home che i test possono toccare.
function risolviProtezione({ home, testRoot = '', cwd = process.cwd(), fsImpl = require('node:fs') } = {}) {
  // Esplicito vince (serve ai test); senza, decide il sistema.
  let reale = String(home || '');
  if (!reale) {
    try {
      const info = require('node:os').userInfo();
      reale = (info && info.homedir) || '';
    } catch (_) { reale = ''; }
  }
  if (!reale) return { homeReale: '', eccezioni: [] };
  // un harness annidato ha una "home reale" gia' di prova: niente da proteggere
  if (testRoot && sottoRadice(path.resolve(reale), path.resolve(String(testRoot)))) return { homeReale: '', eccezioni: [] };
  const eccezioni = [];
  let dir = path.resolve(cwd);
  for (;;) {
    try { if (fsImpl.existsSync(path.join(dir, '.git'))) { eccezioni.push(dir); break; } } catch (_) { break; }
    const su = path.dirname(dir);
    if (su === dir) break;
    dir = su;
  }
  return { homeReale: reale, eccezioni };
}

function creaGuardia({ homeReale, fsImpl = require('node:fs'), pathSep = path.sep, testRoot = '', cwd, eccezioni = [] } = {}) {
  const violazioni = [];
  const originali = new Map();
  let installata = false;
  const protezione = risolviProtezione({ home: homeReale, testRoot, cwd, fsImpl });
  const radice = eccezioni.length ? protezione.homeReale : protezione.homeReale;
  const eccezioniRisolte = eccezioni.map((e) => path.resolve(String(e)))
    .concat(protezione.eccezioni.filter((e) => !eccezioni.includes(e)));

  // true se QUESTA chiamata va rifiutata. Non si guarda la lista accumulata:
  // dopo la prima violazione ogni scrittura legittima verrebbe rifiutata, e il
  // difetto sarebbe della guardia invece che di chi scrive.
  const registra = (op, target) => {
    let percorso = '';
    try {
      percorso = typeof target === 'string' ? target : (target && target.toString ? String(target) : '');
    } catch (_) { percorso = ''; }
    if (!percorso) return false;
    const assoluto = path.resolve(percorso);
    if (!sottoRadice(assoluto, radice)) return false;
    if (eccezioniRisolte.some((e) => sottoRadice(assoluto, e))) return false;
    violazioni.push({ op, path: assoluto });
    return true;
  };

  function installa() {
    if (installata) return;
    for (const nome of NOMI_CHE_SCRIVONO) {
      const originale = fsImpl[nome];
      if (typeof originale !== 'function') continue;
      originali.set(nome, originale);
      fsImpl[nome] = function (target, ...resto) {
        if (registra(nome, target)) {
          const ultima = violazioni[violazioni.length - 1];
          throw new Error(`scrittura rifiutata sotto la home reale: ${nome} ${ultima.path}`
            + ' (isola la HOME dei test, oppure passa una home temporanea esplicita)');
        }
        return originale.call(this, target, ...resto);
      };
    }
    installata = true;
  }

  function ripristina() {
    for (const [nome, originale] of originali) fsImpl[nome] = originale;
    originali.clear();
    installata = false;
  }

  // `null` se non c'e' niente da dire: chi la usa non deve decidere cosa
  // significhi una lista vuota.
  function verifica() {
    if (!violazioni.length) return null;
    const prime = violazioni.slice(0, 3).map((v) => `${v.op} ${v.path}`).join('; ');
    return `${violazioni.length} scrittura/e sotto la home reale (${prime}${violazioni.length > 3 ? '; …' : ''})`;
  }

  return {
    homeReale: radice,
    eccezioni: eccezioniRisolte.slice(),
    installa, ripristina, verifica,
    violazioni: () => violazioni.slice(),
    installata: () => installata,
    // per i test: la stessa decisione, senza toccare il filesystem
    decidere: (percorso) => sottoRadice(path.resolve(String(percorso)), radice)
      && !eccezioniRisolte.some((e) => sottoRadice(path.resolve(String(percorso)), e)),
    pathSep,
  };
}

module.exports = { creaGuardia, sottoRadice, risolviProtezione, NOMI_CHE_SCRIVONO };
