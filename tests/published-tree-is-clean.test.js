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
function tracked() {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean)
    // I documenti interni non finiscono sul mirror: sono esclusi per percorso,
    // non sanificati, ed e' giusto che possano parlare liberamente.
    .filter((f) => !/^(docs\/superpowers\/|test-report\/|docs\/CURRENT_STATE\.md$)/.test(f))
    .map((f) => path.join(ROOT, f));
}

test('nemmeno l\'albero versionato porta quelle tracce, tests inclusi', () => {
  const colpevoli = [];
  for (const file of tracked()) {
    let testo;
    try { testo = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
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
