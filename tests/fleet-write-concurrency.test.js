'use strict';
// Le prove della perdita di scrittura concorrente sulle definizioni fleet —
// e della sua chiusura. Un audit indipendente ha riprodotto il difetto su
// sette percorsi: ognuno fa leggi-modifica-scrivi SENZA lock
// (lib/fleet/builtin.js: `const defs = loadDefinitions(defsPath)` … draft …
// `atomicWrite(defsPath, draft)`), così chi scrive nel frattempo viene
// cancellato. `aggiornaDefinizioni` chiude la finestra: lock file, lettura
// DENTRO il lock, scrittura, rilascio.
//
// Questo file dimostra le due metà, in ordine:
//   1. il difetto ESISTEVA — la forma vecchia perde la scrittura concorrente
//      (test 1: iniezione deterministica dentro la finestra, la stessa
//      tecnica dell'auditor);
//   2. NON ESISTE PIU' — la stessa pressione through aggiornaDefinizioni non
//      perde nulla (test 2 e 5), e i limiti del lock sono DICHIARATI, non
//      nascosti (test 3 e 4).
//
// Il secondo senza il primo non vale: un test verde non dice se stava
// testando qualcosa. Qui il "rosso" della protezione è stato provato
// togliendola (mutazioni temporanee del solo lock: esclusione 'wx'->'w',
// lettura spostata fuori dal lock) — vedere l'handoff del worktree
// work/race-test per i log. Quelle mutazioni vivono solo nei log: lib/ nel
// commit è intatto.
//
// LIMITI DICHIARATI (il punto più importante del file):
//   - Il lock ferma solo chi lo usa. Uno scrittore GREZZO (atomicWrite
//     diretto, come un processo non ancora convertito) che scrive DENTRO la
//     finestra di un altro viene comunque perso: test 3 lo asserisce apertamente
//     invece di fingere protezione.
//   - La corsa "vecchia contro vecchia" tra due processi NON è un test di
//     perdità qui dentro: asserire "devono perdersi scritture" sarebbe flaky
//     sotto carico (dipende dalla sovrapposizione reale dei tempi). La perdita
//     è provata in modo deterministico dal test 1; la sensibilità del test 5
//     è provata dalle mutazioni.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  loadDefinitions, atomicWrite, aggiornaDefinizioni,
} = require('../lib/fleet/definitions.js');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function validDef() {
  return {
    schemaVersion: 1,
    engines: [{
      id: 'claude', label: 'Claude', rc: true,
      command: '/usr/local/bin/claude',
      args: ['--dangerously-skip-permissions'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: '' },
      promptMode: 'flag',
      promptFlag: '--append-system-prompt',
    }],
    cells: [{
      id: 'Build', cwd: '/home/user/work', engine: 'claude',
      boot: true, model: 'opus', prompt: 'you are a dev agent',
    }],
  };
}

const dirsDaRipulire = [];
after(() => { for (const d of dirsDaRipulire) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

// Dir temporanea con un fleet.json valido già sul disco (niente models).
function tmpFleet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-race-'));
  dirsDaRipulire.push(dir);
  const p = path.join(dir, 'fleet.json');
  atomicWrite(p, validDef());
  return { dir, p };
}

// Il "model" è il segnalino che conta una modifica: piccolo, valido per il
// parser strict, e il tetto (MAX_MODELS=64) resta lontano.
const conModel = (defs, id) => ({ ...defs, models: [...(defs.models || []), { id, engine: 'claude' }] });
const idsModels = (p) => (loadDefinitions(p)?.models || []).map((m) => m.id);

// Lavoro CPU (~4-5ms misurati su questa macchina con 250 hash): allarga la
// finestra lettura->scrittura nella forma vecchia, e nella forma con lock è
// semplicemente lavoro fatto DENTRO il lock (che serializza, non protegge
// dalla lentezza). Serve perché la corsa tra processi abbia una finestra da
// sovrapporre, non un istante.
function lavoro() {
  for (let j = 0; j < 250; j += 1) crypto.createHash('sha256').update(String(j)).digest('hex');
}

// Attesa sincrona (siamo in percorsi sincroni per costruzione).
function attendi(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* fallback busy */ } }
}

// ---------------------------------------------------------------------------
// Lo script del processo figlio (per i test 2 e 5). Parametri argv:
//   [fleetPath, prefix, iterazioni, goFile, forma]
// forma 'lock'   -> ogni iterazione passa da aggiornaDefinizioni;
// forma 'vecchia'-> loadDefinitions fuori / atomicWrite dopo (la forma dei
//                   sette percorsi, qui solo per le prove del rosso a mezzo
//                   mutazione: non è eseguita dal gate).
// goFile '-'     -> nessuna attesa di partenza.
// Ogni iterazione è AUTO-VERIFICANTE: se la propria modifica non è sul disco
// subito dopo, il figlio esce non-zero con il perché — una rinuncia silenziosa
// del lock (log + non scrive) non può passare per successo.
// ---------------------------------------------------------------------------
function scriviFiglio(dir) {
  const righe = [
    "'use strict';",
    'const fs = require("node:fs");',
    'const crypto = require("node:crypto");',
    'const [fleetPath, prefix, iterazioniStr, goFile, forma] = process.argv.slice(2);',
    'const DEFS = require(process.env.NC_RACE_DEFS_MODULE);',
    'const lavoro = () => { for (let j = 0; j < 250; j += 1) crypto.createHash("sha256").update(String(j)).digest("hex"); };',
    'const conModel = (defs, id) => ({ ...defs, models: [...(defs.models || []), { id, engine: "claude" }] });',
    'if (goFile !== "-") {',
    '  const deadline = Date.now() + 15000;',
    '  while (!fs.existsSync(goFile)) {',
    '    if (Date.now() > deadline) { console.error("figlio: go timeout"); process.exit(3); }',
    '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);',
    '  }',
    '}',
    'for (let i = 0; i < Number(iterazioniStr); i += 1) {',
    '  const id = prefix + i;',
    '  if (forma === "vecchia") {',
    '    const defs = DEFS.loadDefinitions(fleetPath);',
    '    if (!defs) { console.error("figlio: lettura nulla a iter " + i); process.exit(4); }',
    '    lavoro();',
    '    DEFS.atomicWrite(fleetPath, conModel(defs, id));',
    '  } else {',
    '    DEFS.aggiornaDefinizioni(fleetPath, (defs) => { lavoro(); return conModel(defs, id); });',
    '  }',
    '  const dopo = DEFS.loadDefinitions(fleetPath);',
    '  if (!(dopo && (dopo.models || []).some((m) => m.id === id))) {',
    '    console.error("figlio: la modifica " + id + " non è sul disco dopo la propria scrittura");',
    '    process.exit(5);',
    '  }',
    '}',
    'process.exit(0);',
  ];
  const script = path.join(dir, 'figlio-race.cjs');
  fs.writeFileSync(script, `${righe.join('\n')}\n`, { mode: 0o600 });
  return script;
}

// Spawn di un figlio con stderr catturato per la diagnosi.
function lanciaFiglio(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, NC_RACE_DEFS_MODULE: require.resolve('../lib/fleet/definitions.js') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* non usato */ });
  const uscita = new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal, stderr })); });
  return { child, uscita };
}

// ---------------------------------------------------------------------------
// 1. IL DIFETTO ESISTEVA — forma vecchia, perdita deterministica.
// ---------------------------------------------------------------------------
test('forma vecchia (leggi fuori, scrivi dopo): la scrittura concorrente compare sul disco e poi sparisce', () => {
  const { p } = tmpFleet();

  // Il codice sotto test è la sequenza dei sette percorsi (builtin.js):
  // leggi -> costruisci draft -> scrivi. L'iniezione avviene DOPO la lettura
  // e PRIMA della scrittura: siamo certamente dentro la finestra, senza
  // alcuna attesa che possa diventare flaky. È la tecnica dell'auditor.
  const defs = loadDefinitions(p);                 // 1. leggi, fuori da ogni lock
  assert.ok(defs, 'stato iniziale leggibile');
  const draft = conModel(defs, 'backfill');        // 2. il vecchio costruisce il SUO draft
  atomicWrite(p, conModel(validDef(), 'concorrente')); // …nel frattempo un altro writer pubblica
  const osservato = idsModels(p);                  //    il valore concorrente È sul disco…
  atomicWrite(p, draft);                           // 3. …e il vecchio scrive il draft nato al punto 1

  assert.ok(osservato.includes('concorrente'),
    'il valore concorrente era visibile sul disco prima della sovrascrittura');
  const finale = idsModels(p);
  assert.ok(finale.includes('backfill'), 'la scrittura del vecchio writer è arrivata');
  assert.ok(!finale.includes('concorrente'),
    'PERDITA: la scrittura concorrente è stata cancellata dalla forma vecchia');
});

// ---------------------------------------------------------------------------
// 2. LA PROTEZIONE — stessa pressione, through aggiornaDefinizioni.
//    Il writer concorrente USA il lock (è un processo separato: il lock file
//    è l'unico mezzo che due processi hanno per serializzarsi). Il padre lo
//    spawna DENTRO trasforma — cioè DENTRO il proprio lock — e si trattiene
//    mezzo secondo: la finestra è aperta come nel test 1, anzi di più.
// ---------------------------------------------------------------------------
test('stessa pressione via aggiornaDefinizioni: il writer che usa il lock si serializza e nessuna delle due scritture si perde', async () => {
  const { dir, p } = tmpFleet();
  const script = scriviFiglio(dir);

  let figlio;
  const esito = aggiornaDefinizioni(p, (defs) => {
    // DENTRO il lock: un secondo writer, processo separato, che usa il lock a
    // sua volta. Con il lock vero resta FUORI finché non rilasciamo, poi LEGGE
    // lo stato con la nostra modifica dentro. Il rosso di questo test è stato
    // provato in ENTRAMBE le direzioni: senza esclusione ('wx'->'w') il figlio
    // entra subito e la SUA scrittura viene cancellata dalla nostra; con la
    // lettura fuori dal lock è il figlio che legge adesso (stato senza
    // 'padre') e ci cancella quando entra. Stessa perdita, due finestre.
    figlio = lanciaFiglio(script, [p, 'figlio-', '1', '-', 'lock']);
    attendi(500); // la finestra resta aperta ben oltre l'avvio del figlio
    return conModel(defs, 'padre');
  });
  assert.ok(esito, 'aggiornaDefinizioni completa');

  const { code, signal, stderr } = await figlio.uscita;
  assert.equal(code, 0, `il figlio deve riuscire (signal=${signal}) — stderr: ${stderr}`);

  const finale = idsModels(p);
  assert.ok(finale.includes('padre'), 'la scrittura di chi teneva il lock è arrivata');
  assert.ok(finale.includes('figlio-0'),
    'la scrittura del writer serializzato è arrivata: il figlio ha letto DOPO il padre, non prima');
});

// ---------------------------------------------------------------------------
// 3. IL LIMITE, DICHIARATO — il lock non ferma chi non lo usa.
//    Uno scrittore GREZZO (atomicWrite diretto) che pubblica DENTRO la
//    finestra di aggiornaDefinizioni viene comunque perso. Questo test lo
//    asserisce apertamente: è il confine della protezione, non un difetto
//    del test. La serializzazione copre i writer convertiti; i sette
//    percorsi diventano sicuri MAN MANO che passano ad aggiornaDefinizioni.
// ---------------------------------------------------------------------------
test('limite dichiarato: uno scrittore grezzo dentro la finestra NON è fermato dal lock — la sua scrittura si perde', () => {
  const { p } = tmpFleet();

  const esito = aggiornaDefinizioni(p, (defs) => {
    // DENTRO il nostro lock: un writer non convertito scrive alla vecchia.
    atomicWrite(p, conModel(validDef(), 'grezzo'));
    const osservato = idsModels(p);
    assert.ok(osservato.includes('grezzo'), 'il grezzo è passato (il lock non lo blocca)');
    return conModel(defs, 'protetto');
  });
  assert.ok(esito, 'aggiornaDefinizioni completa anche con l intruso');

  const ricaricato = loadDefinitions(p);
  assert.ok(ricaricato, 'il file resta valido: nessuna corruzione, nessun ibrido');
  assert.deepEqual(ricaricato.models.map((m) => m.id), ['protetto'],
    'il grezzo è STATO perso (finestra residua dichiarata) e il file contiene solo il lavoro fatto sotto lock');
});

// ---------------------------------------------------------------------------
// 4. NON PEGGIORA — il grezzo che completa a lock libero viene letto e
//    conservato dalla successiva aggiornaDefinizioni: la lettura dentro il
//    lock vede lo stato vero del disco, non uno stato ricordato.
// ---------------------------------------------------------------------------
test('scrittore grezzo completato a lock libero: la successiva aggiornaDefinizioni la preserva', () => {
  const { p } = tmpFleet();

  atomicWrite(p, conModel(validDef(), 'grezzo-libero'));  // nessuno tiene il lock
  const esito = aggiornaDefinizioni(p, (defs) => conModel(defs, 'dopo'));
  assert.ok(esito, 'aggiornaDefinizioni completa');

  const finale = idsModels(p);
  assert.ok(finale.includes('grezzo-libero'), 'il lavoro del grezzo sopravvive');
  assert.ok(finale.includes('dopo'), 'il lavoro nuovo è arrivato sopra quello vecchio');
});

// ---------------------------------------------------------------------------
// 5. LA CONCORRENZA VERA — due PROCESSI (non due funzioni) che scrivono
//    insieme sullo stesso file, partenza simultanea al file GO, 30
//    modifiche ciascuno attraverso aggiornaDefinizioni. Il lock file è
//    l'unico punto d'incontro: se l'esclusione o la lettura-dentro-il-lock
//    mancano, qui compaiono modifiche perse (le mutazioni lo hanno mostrato;
//    i log stanno nell handoff). Con il lock vero l'esito è indipendente
//    dallo scheduling: nessuna perdita è possibile, quindi nessun flaky.
// ---------------------------------------------------------------------------
test('due processi in partenza simultanea: 30+30 modifiche via aggiornaDefinizioni, tutte presenti', async () => {
  const { dir, p } = tmpFleet();
  const script = scriviFiglio(dir);
  const go = path.join(dir, 'GO');

  const a = lanciaFiglio(script, [p, 'a-', '30', go, 'lock']);
  const b = lanciaFiglio(script, [p, 'b-', '30', go, 'lock']);
  fs.writeFileSync(go, 'via\n');   // partono davvero insieme, non a cascata

  for (const [nome, f] of [['a', a], ['b', b]]) {
    const { code, signal, stderr } = await f.uscita;
    assert.equal(code, 0, `figlio ${nome} deve riuscire (signal=${signal}) — stderr: ${stderr}`);
  }

  const finale = idsModels(p);
  const diA = finale.filter((id) => id.startsWith('a-')).length;
  const diB = finale.filter((id) => id.startsWith('b-')).length;
  assert.equal(diA, 30, `modifiche del processo a: ${diA}/30 — perse sotto pressione reale`);
  assert.equal(diB, 30, `modifiche del processo b: ${diB}/30 — perse sotto pressione reale`);
  assert.equal(finale.length, 60, 'nessuna modifica estranea o duplicata');
});
