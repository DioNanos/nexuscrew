'use strict';

// Guardia: nessun test scrive sotto la home REALE dell'operatore.
//
// PERCHE' ESISTE, con la data. Il 18/10 un `node --test` lanciato a mano, senza
// HOME isolata, ha scritto `~/.nexuscrew/model-discovery/ollama-cloud.json`
// nella home vera del nodo — con dentro i modelli finti della fixture. Il file
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
//
// Due FORME, perche' l'argomento che scrive non e' sempre il primo:
// - un solo bersaglio: il 1° argomento e' il percorso scritto;
// - due bersagli: copy e rename scrivono ENTRAMBE le estremita' (la sorgente
//   viene spostata o sostituita, la destinazione viene creata o sovrascritta).
//   Sorvegliare solo il primo argomento lasciava passare la copia che FINISCE
//   nella home reale partendo da una sorgente legittima.
const NOMI_UN_BERSAGLIO = Object.freeze([
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync',
  'unlinkSync', 'chmodSync', 'createWriteStream',
]);
const NOMI_DUE_BERSAGLI = Object.freeze(['renameSync', 'copyFileSync']);
// Varianti asincrone a callback (bersaglio primo, callback ultima).
const NOMI_ASYNC_UN_BERSAGLIO = Object.freeze(['writeFile', 'appendFile', 'mkdir', 'rm']);
const NOMI_ASYNC_DUE_BERSAGLI = Object.freeze(['rename', 'copyFile']);
// Le stesse forme sull'API promises (fs.promises.*, unico oggetto insieme a
// require('node:fs/promises')): promesse, non callback.
const NOMI_PROMISES_UN_BERSAGLIO = Object.freeze(['writeFile', 'appendFile', 'mkdir', 'rm']);
const NOMI_PROMISES_DUE_BERSAGLI = Object.freeze(['rename', 'copyFile']);
// Compat: l'unione dei nomi sincroni, com'era prima della suddivisione.
const NOMI_CHE_SCRIVONO = Object.freeze([...NOMI_UN_BERSAGLIO, ...NOMI_DUE_BERSAGLI]);
// LIMITI DICHIARATI (cosa questa lista NON copre): le scritture via file
// descriptor (openSync + writeSync, fs.promises.open e i FileHandle), i nomi
// che codice e test di questo repo non usano per scrivere (symlink, link, cp,
// mkdtemp, truncate, chown, utimes) e le controparti async/promises di
// rmdir/unlink/chmod. La lista resta volutamente sui punti di scrittura
// davvero percorsi; aggiungere una voce e' una riga in piu', qui sopra.

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
  // Ogni voce: { contenitore, nome, originale } — il contenitore serve per
  // rimettere a posto anche le funzioni dell'oggetto `promises`.
  const originali = [];
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

  // Un wrapper per nome avvolto: `indici` sono i numeri d'argomento che
  // portano un percorso scritto (0 per quasi tutte le chiamate, 0 e 1 per
  // copy/rename). Il rifiuto resta SINCRONO, anche sull'API promises: il
  // rumore deve arrivare a chi ha scritto, subito, non a fine processo.
  function wrap(contenitore, nome, indici) {
    const originale = contenitore[nome];
    if (typeof originale !== 'function') return;
    originali.push({ contenitore, nome, originale });
    contenitore[nome] = function (...args) {
      for (const indice of indici) {
        const bersaglio = args[indice];
        if (bersaglio === undefined || bersaglio === null) continue;
        if (registra(nome, bersaglio)) {
          const ultima = violazioni[violazioni.length - 1];
          throw new Error(`scrittura rifiutata sotto la home reale: ${nome} ${ultima.path}`
            + ' (isola la HOME dei test, oppure passa una home temporanea esplicita)');
        }
      }
      return originale.apply(this, args);
    };
  }

  function installa() {
    if (installata) return;
    for (const nome of NOMI_UN_BERSAGLIO) wrap(fsImpl, nome, [0]);
    for (const nome of NOMI_DUE_BERSAGLI) wrap(fsImpl, nome, [0, 1]);
    for (const nome of NOMI_ASYNC_UN_BERSAGLIO) wrap(fsImpl, nome, [0]);
    for (const nome of NOMI_ASYNC_DUE_BERSAGLI) wrap(fsImpl, nome, [0, 1]);
    const promises = fsImpl && typeof fsImpl.promises === 'object' && fsImpl.promises !== null
      ? fsImpl.promises : null;
    if (promises) {
      for (const nome of NOMI_PROMISES_UN_BERSAGLIO) wrap(promises, nome, [0]);
      for (const nome of NOMI_PROMISES_DUE_BERSAGLI) wrap(promises, nome, [0, 1]);
    }
    installata = true;
  }

  function ripristina() {
    for (const { contenitore, nome, originale } of originali) contenitore[nome] = originale;
    originali.length = 0;
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
