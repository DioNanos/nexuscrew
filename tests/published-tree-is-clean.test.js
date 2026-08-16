'use strict';
// tests/published-tree-is-clean.test.js — cio' che finisce nel pacchetto non
// deve raccontare da dove viene.
//
// PERCHE' E' UN TEST E NON UNA CHECKLIST. La verifica prima di pubblicare c'era
// gia', ma la facevo a mano, ricostruendo a memoria l'elenco dei motivi da
// cercare. Il 2026-08-07 quell'elenco conteneva percorsi, hostname e
// attribuzioni AI, e NON i nomi delle celle interne: la 0.8.53 e' uscita su npm
// con `// (rilievo R1 di <cella> su rc.14)` dentro un file che il pacchetto
// spedisce. Nessun segreto — ma e' esattamente la classe che la regola copre, e
// npm non si ripubblica.
//
// Una lista scritta a mano copre cio' che ricordi. Un test copre cio' che c'e',
// e fallisce prima del publish invece che dopo.
//
// COSA NON PROVA: che il pacchetto sia "sicuro". Prova che non contenga le
// tracce che sappiamo di dover togliere. Un motivo nuovo va aggiunto qui,
// preferibilmente lo stesso giorno in cui lo si scopre.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Le directory che `package.json:files` spedisce davvero. Tenerle allineate a
// mano sarebbe lo stesso errore di prima, quindi si leggono da li'.
function published() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = [];
  for (const entry of pkg.files || []) {
    const p = path.join(ROOT, entry);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Ogni voce dice PERCHE' e' vietata: un elenco di stringhe senza motivo si
// svuota di senso e prima o poi qualcuno ne toglie una per far passare la
// suite.
const VIETATI = [
  // LA REGOLA E' «non la home di CHI COSTRUISCE», e si ricava: scrivere un
  // elenco di nomi ammessi era sbagliato in entrambi i versi. Troppo stretto,
  // perche' segnaposto legittimi come /home/user o /home/foreign finivano
  // segnalati; e troppo largo, perche' un nome reale non previsto sarebbe
  // passato. Il rischio vero e' pubblicare il percorso di casa di chi ha
  // costruito il pacchetto, e quello lo sa il sistema.
  //
  // Il lookbehind serve comunque: senza, «session/api/home/fileExists» dentro
  // un commento viene preso per un percorso.
  { re: new RegExp(`(?<![\\w-])/home/${require('node:os').userInfo().username}(/|\\b)`),
    perche: 'percorso della home di chi costruisce (nei test usare /home/tester)' },
  { re: /DocsHub/,
    perche: 'nome del repository interno di documentazione' },
  { re: /\bDev(Worker|Auditor)\b|\bForkAuditor\b/,
    perche: 'attribuzione a una cella interna: e\' cio\' che e\' sfuggito nella 0.8.53' },
  { re: /Co-Authored-By|Generated with \[?Claude/,
    perche: 'attribuzione AI' },
  // L'handle dell'operatore come PAROLA ISOLATA. Il lookaround evita i falsi
  // positivi ovvi (parole che lo contengono); misurato sull'albero attuale:
  // zero occorrenze, quindi la guardia nasce verde e non copre un debito.
  { re: /(?<![\w-])DAG(?![\w-])/,
    perche: 'handle dell\'operatore nel testo pubblicato' },
  // Marker di processo interno: il verdetto di una revisione e il register di
  // merge vivono nella documentazione interna, non in un albero che si legge da
  // fuori. Un lettore esterno non deve ricostruire come lavoriamo dai commenti.
  { re: /NEEDS_CHANGES|merge-feature-register/,
    perche: 'marker di processo interno (verdetto di revisione / register)' },
];

// DEC3 — CHI viene guardato, non COSA si cerca (i pattern sopra non cambiano).
// Prima di DEC3 i binari (file con un byte NUL) erano saltati IN SILENZIO con
// un `if (testo.includes('\0')) continue;`: nessun conteggio, nessun elenco, e
// un file non ispezionato produceva lo stesso verde di uno pulito. Il guardiano
// stesso (questo file) era fuori dal proprio controllo — si saltava da solo
// perche' la riga del NUL conteneva un byte NUL letterale, e intanto porta
// dentro DocsHub, DevAuditor e /home/<user> PER DEFINIZIONE.
//
// Ora il salto e' DICHIARATO: l'elenco dei binari legittimi e le esclusioni per
// nome sono qui sotto, e un file binario nuovo non coperto FA FALLIRE il test,
// cosi' qualcuno e' costretto a guardarlo invece di vederlo passare verde.

// Binari legittimi nell'albero: solo immagini (formati binari). Un font, un .bin
// o qualunque altro binario non immagine non e' coperto: chi lo aggiunge e'
// costretto a dichiararlo qui o a ispezionarlo.
const BINARI_LEGITTIMI = /\.(?:png|jpe?g|gif|webp|icns|ico|bmp|tiff?)$/i;
// Il file che DEFINISCE i pattern vietati si auto-accuserebbe: li contiene per
// definizione. Escluso PER NOME e con questo commento che spiega il perche':
// un'esclusione dichiarata si legge e si discute, una per effetto collaterale
// (il byte NUL della regex) no.
const SELF_EXCLUDE = 'tests/published-tree-is-clean.test.js';

// Classifica un file: ritorna l'array (vuoto se pulito) dei motivi di colpa.
// Estratta perche' sia richiamata sia dall'albero versionato sia dal pacchetto,
// e perche' il controllo negativo la eserciti su input sintetici (non su file
// reali). Pura: fuori esce solo l'elenco dei motivi, mai il contenuto.
function colpeIn(testo, rel) {
  if (rel === SELF_EXCLUDE) return [];
  if (testo.includes('\0')) {
    return BINARI_LEGITTIMI.test(rel)
      ? []
      : [`${rel}: file binario (byte NUL) non dichiarato come immagine legittima — va ispezionato, non saltato`];
  }
  const colpe = [];
  for (const { re, perche } of VIETATI) {
    const m = testo.match(re);
    if (m) colpe.push(`${rel}: ${perche} — «${m[0]}»`);
  }
  return colpe;
}

// Il mirror pubblico porta PIU' del pacchetto npm: anche `tests/`, che `files`
// non spedisce. La sanificazione di quei file viveva solo sul ramo pubblico e
// andava rifatta a mano a ogni release — e il confronto con il ramo di lavoro
// non la rivelava, perche' i due combaciavano proprio sul lato non sanificato.
// Il 2026-08-07 quella riconciliazione manuale e' saltata al primo tentativo.
// Ora i file sono puliti alla radice e questo test lo mantiene vero.
//
// QUESTA E' UNA SIMULAZIONE LOCALE, NON LA VERIFICA DEL MIRROR. L'esclusione
// qui sotto presuppone che `docs/superpowers/`, `test-report/` e
// `docs/CURRENT_STATE.md` non arrivino mai sul mirror pubblico — e' la regola
// scritta in DocsHub/projects/nexuscrew/ROADMAP.md, non un fatto verificato
// da questo test. Sul ramo interno quei percorsi possono parlare liberamente
// (decisione DAG 2026-08-05: Forge non si sanifica), quindi qui restano
// esclusi apposta. Il controllo che quella regola sia VERA sul mirror reale
// e' nei due test 'IL MIRROR REALE' piu' sotto: e' li' che si scopre se
// l'assunzione ha retto, non qui. Il 2026-08-15 non aveva retto: nove file
// (poi risultati undici) erano nell'indice di github/main nonostante questa
// esclusione locale li desse per assenti.
function tracked() {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean)
    // I documenti interni non finiscono sul mirror (per regola — vedi sopra):
    // sono esclusi per percorso, non sanificati, ed e' giusto che possano
    // parlare liberamente SU QUESTO ramo.
    .filter((f) => !/^(docs\/superpowers\/|test-report\/|docs\/CURRENT_STATE\.md$)/.test(f))
    .map((f) => path.join(ROOT, f));
}

// --- IL MIRROR REALE -------------------------------------------------------
// I due test sopra (tracked/published) verificano alberi LOCALI, prevedendo
// cosa dovrebbe succedere se il mirror venisse costruito per regola. Nessuno
// dei due apre mai `github/main`. Il 2026-08-15 questo ha lasciato passare
// undici file interni gia' pubblicati (nove noti + due sotto `test-report/`
// non ancora segnalati), perche' la regola di esclusione sopra e' stata
// scambiata per un fatto sul mirror invece che per un'intenzione su di esso.
//
// Qui si legge l'unica cosa che conta davvero: cosa c'e' OGGI su github/main.
function alberoGithubReale() {
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['fetch', 'github', 'main'], { cwd: ROOT, stdio: 'pipe' });
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'github/main'],
    { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function leggiDaGithub(rel) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('git', ['show', `github/main:${rel}`], { cwd: ROOT, encoding: 'utf8' });
}

// I percorsi che, per la regola scritta in ROADMAP.md, non devono MAI comparire
// nel mirror pubblico. E' un PREFISSO, non un elenco di nomi: un file nuovo
// scritto domani sotto `docs/superpowers/` fa fallire questo test tanto quanto
// i nove di oggi, senza bisogno di aggiungerlo a mano da nessuna parte. E'
// proprio l'assenza di questa proprieta' — un'esclusione per nome invece che
// per regola — il difetto che ha lasciato passare gli undici file di oggi.
const PERCORSI_VIETATI_NEL_MIRROR = [
  { re: /^docs\/superpowers\//, perche: 'documentazione interna di pianificazione, esclusa per regola dal mirror' },
  { re: /^test-report\//, perche: 'report di test interno, escluso per regola dal mirror' },
  { re: /^docs\/CURRENT_STATE\.md$/, perche: 'stato interno del progetto, escluso per regola dal mirror' },
  // Il NOME di un file e' leggibile dall'indice di GitHub senza aprire nulla:
  // due dei file rimossi il 2026-08-15 portavano il nome di una macchina
  // proprio li'. I pattern sul CONTENUTO non li avrebbero fermati se il testo
  // fosse stato pulito, e i tre prefissi sopra li prendono solo finche' il file
  // sta in quelle cartelle.
  //
  // I CONFINI QUI SONO `[a-z0-9]`, NON `[\w-]` come nei pattern sul contenuto.
  // Nei percorsi il separatore normale e' proprio `-` o `_`: con `[\w-]` il
  // lookbehind escluderebbe «nexuscrew-vps3.md», cioe' esattamente il caso da
  // prendere. Provato: la prima versione di questa guardia non mordeva NULLA e
  // restava verde.
  //
  // Il nome della macchina che costruisce si ricava — ma solo se e' specifico:
  // qui la prima etichetta puo' essere una parola comune («cloud»), e vietarla
  // farebbe fallire il gate su un futuro docs/cloud-setup.md. Si usa il nome
  // pieno e il dominio senza TLD, che generici non sono.
  ...(() => {
    const host = require('node:os').hostname();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parti = host.split('.');
    const nomi = parti.length > 2 ? [host, parti.slice(1, -1).join('.')] : (parti.length > 1 ? [host] : []);
    return nomi.filter((n) => n.length > 4).map((n) => ({
      re: new RegExp(`(?<![a-z0-9])${esc(n)}(?![a-z0-9])`, 'i'),
      perche: 'nome della macchina che costruisce, nel percorso',
    }));
  })(),
  // Gli ALTRI nostri nomi non sono ricavabili da qui, quindi questo e' un
  // elenco — e un elenco non e' una garanzia: un nome nuovo, non previsto,
  // passerebbe. La difesa che regge resta il divieto per prefisso; questa e'
  // la rete sotto, per il caso «file interno finito fuori dalle sue cartelle».
  { re: /(?<![a-z0-9])(vps\d+|mac[_-]?air|pixel\d*pro|novalnx|asusrp\d*|notpg)(?![a-z0-9])/i,
    perche: 'nome di una nostra macchina nel percorso (elenco noto, non esaustivo)' },
];

// Il test qui sotto e' verde anche se i pattern non mordono NULLA: guarda un
// albero pulito e non trova niente, che e' esattamente cio' che si vede quando
// una guardia e' rotta. Provato sul campo: la prima versione dei pattern sui
// nomi usava `[\w-]` come confine, quindi escludeva il trattino — cioe' il
// separatore normale dei nomi di file — e non prendeva «...-vps3.md», il caso
// per cui era stata scritta. Restava verde.
//
// Quindi i pattern vanno esercitati per conto loro, sui due versi: mordono cio'
// che devono, e lasciano stare cio' che e' legittimo. Il secondo verso conta
// quanto il primo: un pattern sul nome generico della macchina («cloud»)
// farebbe fallire il gate su un futuro docs/cloud-setup.md.
test('i divieti sui percorsi mordono i casi giusti e solo quelli', () => {
  const morde = (rel) => PERCORSI_VIETATI_NEL_MIRROR.some(({ re }) => re.test(rel));
  const casi = [
    ['docs/superpowers/piano.md', true, 'prefisso interno'],
    ['test-report/audit.md', true, 'prefisso interno'],
    ['docs/CURRENT_STATE.md', true, 'percorso esatto'],
    ['docs/2026-07-06-nexuscrew-vps3.md', true, 'nome macchina dopo un trattino'],
    ['docs/setup-VPS1-notes.md', true, 'nome macchina, altro caso'],
    ['docs/mac_air-build.md', true, 'nome macchina con underscore'],
    ['docs/guide.md', false, 'documento legittimo'],
    ['docs/cloud-setup.md', false, 'parola comune: NON deve mordere'],
    ['docs/CONFIGURATION.md', false, 'documento legittimo'],
    ['lib/proxy/panel-proxy.js', false, 'codice'],
    ['frontend/src/lib/api.js', false, 'codice'],
  ];
  const sbagliati = casi
    .filter(([rel, atteso]) => morde(rel) !== atteso)
    .map(([rel, atteso, perche]) => `${rel}: atteso ${atteso ? 'MORSO' : 'passante'} (${perche})`);
  assert.deepEqual(sbagliati, [],
    `i divieti non si comportano come dichiarato:\n  ${sbagliati.join('\n  ')}`);
});

test('IL MIRROR REALE (github/main) non contiene i percorsi interni vietati', () => {
  const colpevoli = [];
  for (const rel of alberoGithubReale()) {
    for (const { re, perche } of PERCORSI_VIETATI_NEL_MIRROR) {
      if (re.test(rel)) colpevoli.push(`${rel}: ${perche}`);
    }
  }
  assert.deepEqual(colpevoli, [],
    `github/main contiene questi percorsi interni (la regola dice che non dovrebbero esserci):\n  ${colpevoli.join('\n  ')}`);
});

// Il ciclo sta QUI, fuori dal test, e prende il lettore come argomento: e'
// l'unico modo di provare che si accorge di NON aver letto. Con la lettura
// cablata dentro, il caso «il contenuto non si legge» non e' esprimibile e
// resta scoperto — che e' esattamente com'e' passato inosservato.
function scansionaContenuti(elenco, leggi) {
  const colpevoli = [];
  let ispezionati = 0;
  for (const rel of elenco) {
    let testo;
    // Un blob che non si legge NON si salta: saltandolo, il test direbbe
    // «pulito» per non aver guardato. Con un `continue` cieco qui, 557 letture
    // fallite hanno lasciato il gate verde avendo ispezionato ZERO contenuti.
    try { testo = leggi(rel); }
    catch (e) { colpevoli.push(`${rel}: contenuto NON ISPEZIONATO (${e && e.message ? String(e.message).split('\n')[0] : 'lettura fallita'})`); continue; }
    ispezionati += 1;
    colpevoli.push(...colpeIn(testo, rel));
  }
  return { colpevoli, ispezionati };
}

test('IL MIRROR REALE (github/main) non porta le tracce vietate nel contenuto', () => {
  // Copre cio' che il controllo per percorso sopra non copre: materiale
  // interno finito FUORI dai tre prefissi noti. Riusa colpeIn — stessa
  // regola, stessa esclusione per il file che la definisce (SELF_EXCLUDE).
  const albero = alberoGithubReale();
  const { colpevoli, ispezionati } = scansionaContenuti(albero, leggiDaGithub);
  // E nemmeno un albero vuoto vale come «pulito»: senza questa riga il test
  // resta verde anche quando non c'e' NIENTE da guardare, che e' l'altro modo
  // di non distinguere «non trovo niente» da «non ho cercato».
  assert.ok(ispezionati > 0 && ispezionati === albero.length,
    `ispezionati ${ispezionati} blob su ${albero.length}: il gate deve leggerli tutti, o non sta verificando l'albero pubblicato`);
  assert.deepEqual(colpevoli, [],
    `github/main contiene queste tracce (fuori dai percorsi gia' vietati sopra):\n  ${colpevoli.join('\n  ')}`);
});

test('CONTROLLO NEGATIVO: se i contenuti non si leggono, il gate deve diventare ROSSO', () => {
  // La prova che il test sopra non e' verde per assenza di ispezione. Un
  // auditor l'ha ottenuta dirottando `git show` con un finto nel PATH: 557
  // letture fallite, zero blob guardati, gate verde ed exit 0. Qui la stessa
  // condizione e' dentro il gate, quindi non puo' tornare senza che si veda.
  const elenco = ['README.md', 'package.json', 'lib/cli/commands.js'];
  const illeggibile = () => { throw new Error('fatal: path does not exist in github/main'); };

  const rotto = scansionaContenuti(elenco, illeggibile);
  assert.equal(rotto.ispezionati, 0, 'nessun contenuto doveva risultare ispezionato');
  assert.equal(rotto.colpevoli.length, elenco.length,
    'ogni lettura fallita deve produrre una colpa: se questo elenco e\' vuoto, il gate e\' tornato cieco');
  for (const c of rotto.colpevoli) assert.match(c, /NON ISPEZIONATO/);

  // Controprova sullo stesso ciclo: con un lettore che funziona e contenuti
  // innocui, non inventa colpe.
  const sano = scansionaContenuti(elenco, () => 'contenuto del tutto innocuo\n');
  assert.deepEqual(sano.colpevoli, [], 'il ciclo accusa contenuti puliti');
  assert.equal(sano.ispezionati, elenco.length);
});

test('nemmeno l\'albero versionato porta quelle tracce, tests inclusi', () => {
  const colpevoli = [];
  // Stessa correzione del test sopra, e per la stessa ragione: due copie della
  // medesima logica avevano lo stesso `continue` cieco.
  for (const file of tracked()) {
    let testo;
    try { testo = fs.readFileSync(file, 'utf8'); }
    catch (e) { colpevoli.push(`${path.relative(ROOT, file)}: contenuto NON ISPEZIONATO (${e && e.code ? e.code : 'lettura fallita'})`); continue; }
    colpevoli.push(...colpeIn(testo, path.relative(ROOT, file)));
  }
  assert.deepEqual(colpevoli, [],
    `il mirror pubblico non deve contenere queste tracce:\n  ${colpevoli.join('\n  ')}`);
});

test('l\'albero pubblicato non porta tracce di dove e\' stato costruito', () => {
  const colpevoli = [];
  for (const file of published()) {
    let testo;
    try { testo = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    colpevoli.push(...colpeIn(testo, path.relative(ROOT, file)));
  }
  assert.deepEqual(colpevoli, [],
    `il pacchetto non deve contenere queste tracce:\n  ${colpevoli.join('\n  ')}`);
});

test('l\'elenco dei motivi non e\' vuoto ne\' inerte', () => {
  // Se qualcuno svuotasse VIETATI, il test sopra passerebbe sempre: verde per
  // assenza di controlli invece che per assenza di tracce. Qui si prova che i
  // motivi mordono ancora, su un testo costruito apposta.
  const io = require('node:os').userInfo().username;
  const finto = `vedi /home/${io}/segreto e DocsHub/x, rilievo di DevAuditor, Co-Authored-By: x, chiesto da DAG, verdetto NEEDS_CHANGES`;
  const presi = VIETATI.filter(({ re }) => re.test(finto));
  assert.equal(presi.length, VIETATI.length,
    'ogni motivo deve riconoscere il proprio caso: se uno non morde, e\' decorativo');
  // E non devono mordere il caso legittimo.
  // I segnaposto sintetici NON devono mordere: erano falsi positivi della
  // prima stesura, e un guardiano che grida al lupo si smette di ascoltarlo.
  for (const ok of ['/home/tester/.ssh/id_ed25519', '/home/user/work', '/home/foreign/x', 'session/api/home/fileExists', 'DAGGER', 'my-DAG-graph', 'topological DAGs']) {
    assert.ok(!VIETATI.some(({ re }) => re.test(ok)), `falso positivo su: ${ok}`);
  }
});

// DEC3 — controlli negativi: il salto dei binari non e' piu' silenzioso.
test('DEC3 CONTROLLO NEGATIVO: un binario non immagine con NUL e traccia vietata FA FALLIRE (mai verde per assenza di ispezione)', () => {
  // Un file con byte NUL e una traccia vietata NON e' un'immagine dichiarata:
  // colpeIn lo cattura come binario da ispezionare. Cosi', se una traccia finisce
  // in un file che contiene un NUL, il gate NON resta verde — ed e' proprio il
  // fallimento che il test deve prevenire (la lezione della 0.8.53).
  const c1 = colpeIn('before\0after DocsHub/x', 'src/fittizio.dat');
  assert.ok(c1.length >= 1, 'un binario non immagine deve essere colpevole');
  assert.ok(c1.some((x) => x.includes('binario') && x.includes('ispezionato')),
    'segnalato come binario da ispezionare, non saltato');
  // E un .md (testo per estensione) con un NUL dentro e' comunque un binario ai
  // fini dell'ispezione: colpevole in ogni caso, mai verde.
  assert.ok(colpeIn('DocsHub\0x', 'docs/note.md').length >= 1,
    'NUL + traccia in un .md: colpevole (il NUL non nasconde la traccia)');
});

test('DEC3: il file dei pattern e\' escluso PER NOME (auto-accusa dichiarata), non per il NUL', () => {
  const testo = fs.readFileSync(path.join(ROOT, SELF_EXCLUDE), 'utf8');
  // Si auto-accuserebbe: contiene i pattern vietati PER DEFINIZIONE (li cerca).
  const diretti = VIETATI.filter(({ re }) => re.test(testo));
  assert.ok(diretti.length >= 1, 'il file dei pattern contiene almeno un pattern vietato');
  // Ma e' escluso per nome: colpeIn ritorna vuoto per SELF_EXCLUDE. Non e' il
  // byte NUL a salvarlo (questa versione non ne ha uno letterale): e' il nome.
  assert.deepEqual(colpeIn(testo, SELF_EXCLUDE), []);
});
