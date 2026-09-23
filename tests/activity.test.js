'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  leggiAttivita, scriviStato, scriviGenerazione, statoDaEvento, daRegistrare,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS, USCITA, AVVIO,
} = require('../lib/files/activity.js');

const SESSIONE = 'cloud-Prova';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-activity-'));
}
function dirSessione(root) {
  return path.join(root, SESSIONE);
}
function scriviFile(root, contenuto) {
  fs.mkdirSync(dirSessione(root), { recursive: true });
  fs.writeFileSync(path.join(dirSessione(root), NOME_FILE), contenuto);
}

const GEN = 'gen-1';

// Una cella LANCIATA dal supervisore NUOVO: generazione su disco COL SEGNO
// dell'uscita. Serve a quasi tutti i casi da qui in giu': con il disegno nuovo
// un evento senza generazione non e' leggibile — non e' legato ad alcun lancio —
// e «ferma» non scade solo dove il supervisore garantisce l'invalidazione.
function lanciata(root, { garantita = true, gen = GEN } = {}) {
  assert.equal(scriviGenerazione(dirSessione(root), gen, { uscitaGarantita: garantita }), true,
    'il lancio scrive la generazione');
  return gen;
}

// Un evento DI QUEL lancio: la generazione e' sempre quella.
function evento(root, nome, extra = {}) {
  return scriviStato(dirSessione(root), { evento: nome, generazione: GEN, ...extra });
}

// --- mappa evento -> stato (la matrice MISURATA nel Gate A) ----------------

test('statoDaEvento: la matrice misurata su 2.1.280', () => {
  assert.equal(statoDaEvento('SessionStart'), 'ferma');
  assert.equal(statoDaEvento('Stop'), 'ferma');
  assert.equal(statoDaEvento('UserPromptSubmit'), 'lavora');
  assert.equal(statoDaEvento('PreToolUse'), 'lavora');
  assert.equal(statoDaEvento('PostToolUse'), 'lavora');
  assert.equal(statoDaEvento('PermissionRequest'), 'attesa');
  assert.equal(statoDaEvento('Notification', 'permission_prompt'), 'attesa');
});

test('SubagentStop NON chiude il turno: resta lavora (il padre lavora ancora)', () => {
  assert.equal(statoDaEvento('SubagentStop'), 'lavora');
});

test('Notification di tipo non misurato non autorizza transizioni', () => {
  assert.equal(statoDaEvento('Notification', 'idle_prompt'), null, 'esempio: solo permission_prompt e misurato');
  assert.equal(statoDaEvento('Notification'), null);
  assert.equal(statoDaEvento('Notification', null), null);
});

test('SessionEnd non afferma ferma: la sessione non esiste piu', () => {
  assert.equal(statoDaEvento('SessionEnd'), null);
  assert.equal(statoDaEvento('StopFailure'), null, 'non emesso su 2.1.280');
  assert.equal(statoDaEvento('EventoInventato'), null);
  assert.equal(statoDaEvento(''), null);
  assert.equal(statoDaEvento(null), null);
});

// --- cosa si scrive e cosa no ---------------------------------------------

test('daRegistrare: una Notification di tipo non misurato NON tocca il file', () => {
  const { daRegistrare } = require('../lib/files/activity.js');
  // Se la scrivesse, sovrascriverebbe un «lavora» fresco con un evento che il
  // lettore non sa mappare: la cella diventerebbe «non verificata» mentre
  // lavora. Il tipo qui sotto e' un ESEMPIO, non una misura: di
  // `notification_type` e' stato osservato un solo valore
  // (`permission_prompt`). La regola non dipende da quale sia l'altro tipo —
  // e' che tutto cio' che non e' quello misurato non tocca il file.
  assert.equal(daRegistrare('Notification', 'idle_prompt'), false);
  assert.equal(daRegistrare('Notification', 'qualunque_altro_tipo'), false);
  assert.equal(daRegistrare('Notification'), false);
  assert.equal(daRegistrare('Notification', 'permission_prompt'), true);
  assert.equal(daRegistrare('EventoInventato'), false);
  assert.equal(daRegistrare(''), false);
  assert.equal(daRegistrare(null), false);
});

test('daRegistrare: SessionEnd si scrive — e cosi che il dato viene invalidato', () => {
  const { daRegistrare } = require('../lib/files/activity.js');
  // Non dichiara uno stato, ma se non lo si scrivesse resterebbe in giro il
  // «lavora» di una sessione che non esiste piu' per tutta la finestra.
  assert.equal(daRegistrare('SessionEnd'), true);
  for (const evento of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'PermissionRequest']) {
    assert.equal(daRegistrare(evento), true, evento);
  }
  assert.equal(daRegistrare('StopFailure'), false, 'non emesso su 2.1.280');
});

test('un SessionEnd scritto invalida lo stato precedente', () => {
  const root = tmpRoot();
  lanciata(root);
  evento(root, 'UserPromptSubmit');
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'lavora');
  evento(root, 'SessionEnd');
  assert.equal(leggiAttivita(root, SESSIONE), null, 'la sessione non esiste piu: non «ferma»');
});

// --- lo script hook, eseguito davvero -------------------------------------
//
// Le regole sopra valgono se lo script le applica. Qui lo si esegue come lo
// esegue il client: processo figlio, payload su stdin, nessun output atteso.

const { spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'bin', 'nc-activity-hook.js');
const { spawn } = require('node:child_process');

function eseguiHook(dir, nomeEvento, payload) {
  // `--gen` c'e': in produzione il comando dell'hook lo porta (cell-exec lo
  // costruisce dalla generazione del payload), ed e' la generazione che rende
  // leggibile l'evento.
  return spawnSync(process.execPath, [SCRIPT, '--event', nomeEvento, '--dir', dir, '--gen', GEN],
    { input: JSON.stringify(payload), encoding: 'utf8' });
}

test('lo script hook: scrive l\'evento mappato, tace, ed esce 0', () => {
  const root = tmpRoot();
  const dir = dirSessione(root);
  lanciata(root);
  const r = eseguiHook(dir, 'UserPromptSubmit', { session_id: 's1', prompt: 'testo del prompt' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'un hook che stampa puo alterare il turno');
  assert.equal(r.stderr, '', 'nemmeno su stderr');
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'lavora');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, NOME_FILE), 'utf8'));
  assert.equal(raw.session_id, 's1');
  assert.equal(JSON.stringify(raw).includes('testo del prompt'), false, 'il payload non finisce nel file');
});

test('lo script hook: una Notification di altro tipo NON tocca il file', () => {
  const root = tmpRoot();
  const dir = dirSessione(root);
  lanciata(root);
  eseguiHook(dir, 'UserPromptSubmit', {});
  const prima = fs.readFileSync(path.join(dir, NOME_FILE), 'utf8');
  const r = eseguiHook(dir, 'Notification', { notification_type: 'idle_prompt' });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, NOME_FILE), 'utf8'), prima,
    'lo stato non e stato riscritto: la cella resta «al lavoro»');
  // e con il tipo giusto, invece, scrive.
  eseguiHook(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'attesa');
});

test('lo script hook: senza --event o senza --dir non scrive nulla', () => {
  const root = tmpRoot();
  const dir = dirSessione(root);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--dir', dir], { input: '{}' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--event', 'Stop'], { input: '{}' }).status, 0);
  assert.equal(fs.existsSync(path.join(dir, NOME_FILE)), false);
});

// --- lettura: transizioni -------------------------------------------------

test('ogni transizione scrive uno stato leggibile', () => {
  const root = tmpRoot();
  const casi = [
    ['SessionStart', 'ferma'],
    ['UserPromptSubmit', 'lavora'],
    ['PreToolUse', 'lavora'],
    ['PostToolUse', 'lavora'],
    ['PermissionRequest', 'attesa'],
    ['Stop', 'ferma'],
  ];
  lanciata(root);
  for (const [nome, atteso] of casi) {
    evento(root, nome, { sessionId: 's1' });
    const letto = leggiAttivita(root, SESSIONE);
    assert.equal(letto && letto.stato, atteso, `evento ${nome}`);
  }
});

test('Notification permission_prompt -> attesa', () => {
  const root = tmpRoot();
  lanciata(root);
  evento(root, 'Notification', { tipo: 'permission_prompt' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'attesa');
});

// --- la scadenza: scaduto NON e' idle, ma non per tutti --------------------

test('«ferma» NON scade con l\'eta: un turno finito resta finito', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'Stop', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS - 1).stato, 'ferma');
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS + 1).stato, 'ferma',
    'oltre la finestra resta «ferma»: non è un dato che deve verificare altro');
  // E un'ora dopo, ancora: la finestra non lo riguarda.
  assert.equal(leggiAttivita(root, SESSIONE, ora + 60 * 60 * 1000).stato, 'ferma');
});

test('Interrupt vecchio: stesso contratto di Stop', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'Interrupt', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 60 * 60 * 1000).stato, 'ferma');
});

test('Stop vecchio ma di un\'ALTRA generazione: null — è un altro lancio', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviGenerazione(dirSessione(root), 'gen-corrente');
  scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'gen-vecchia', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000), null,
    'la fine del processo invalida con la generazione, non con l\'eta');
});

test('un evento di LAVORO vecchio sei minuti -> null: il Ctrl-C resta coperto', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviStato(dirSessione(root), { evento: 'PreToolUse', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 6 * 60 * 1000), null);
});

test('un ts nel futuro oltre la tolleranza non resta fresco per sempre', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'UserPromptSubmit', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora - 1000).stato, 'lavora', 'skew piccolo tollerato');
  assert.equal(leggiAttivita(root, SESSIONE, ora - FUTURO_TOLLERATO_MS - 1000), null);
});

test('il caso Ctrl-C: nessun evento nuovo -> il dato scade invece di mentire', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  // Un turno partito e mai chiuso: misurato, Ctrl-C non emette alcun evento.
  lanciata(root);
  evento(root, 'UserPromptSubmit', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'lavora');
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS + 1), null,
    'non «ferma»: non verificato');
});

// --- generazione ----------------------------------------------------------

test("la generazione decide: senza generazione niente stato, e il mismatch e' un altro lancio", () => {
  const root = tmpRoot();
  const dir = dirSessione(root);

  // 1. Nessuna generazione su disco: niente da leggere, nemmeno se l'evento ne
  //    dichiara una. Non c'e' piu' il formato «storico» senza generazione: un
  //    evento che non e' legato a un lancio non e' invalidabile da nessuno, e
  //    con «ferma» che non scade resterebbe vero per sempre.
  scriviStato(dir, { evento: 'UserPromptSubmit', generazione: 'gen-1' });
  assert.equal(leggiAttivita(root, SESSIONE), null, 'senza activity.gen non si legge');

  // 2. Generazione su disco, evento di un ALTRO lancio: scartato. La fine del
  //    processo invalida con la generazione, non con l'eta'.
  scriviGenerazione(dir, 'gen-nuova', { uscitaGarantita: true });
  assert.equal(leggiAttivita(root, SESSIONE), null, "mismatch: e' un altro lancio");

  // 3. Un evento SENZA generazione non vale mai, nemmeno con la generazione su
  //    disco: gli hook la scrivono da D-340, e un evento che non la porta non
  //    ha nessuno che possa invalidarlo.
  scriviStato(dir, { evento: 'Stop' });
  assert.equal(leggiAttivita(root, SESSIONE), null, 'evento senza generazione: scartato');

  // 4. Lo stesso evento con la generazione giusta si legge.
  scriviStato(dir, { evento: 'Stop', generazione: 'gen-nuova' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'ferma');
});

// --- l'uscita del client: il riavvio INTERNO del supervisore --------------
//
// Il supervisore riavvia il client dentro lo STESSO lancio (cell-exec.js), quindi
// `activity.gen` non cambia: la regola 3 non puo' accorgersi che il client
// precedente e' morto. E' l'evento di uscita a dirlo.

test('l\'uscita del client invalida «ferma»: il riavvio interno non eredita lo stato', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviGenerazione(dirSessione(root), 'gen-1');
  scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'gen-1', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'ferma');

  scriviStato(dirSessione(root), { evento: USCITA, generazione: 'gen-1', ora: ora + 2000 });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 3000), null,
    'client morto = non verificato, mai «ferma» durante il backoff');
  assert.equal(leggiAttivita(root, SESSIONE, ora + 60 * 60 * 1000), null,
    'e non torna «ferma» col passare del tempo');
});

test('l\'uscita non dichiara uno stato e non e\' registrabile dagli hook', () => {
  // Non e' una transizione: invalida. E non la scrive lo script degli hook —
  // la scrive il supervisore, che e' l'unico a sapere quando il client esce.
  assert.equal(statoDaEvento(USCITA), null);
  assert.equal(daRegistrare(USCITA), false);
});

// --- scrittura concorrente ------------------------------------------------

test('scritture in sequenza: il lettore non vede mai un file a meta', async () => {
  const root = tmpRoot();
  lanciata(root);
  const eventi = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'];
  await Promise.all(eventi.map((nome) => Promise.resolve().then(
    () => evento(root, nome))));
  const letto = leggiAttivita(root, SESSIONE);
  assert.ok(letto, 'il file resta leggibile');
  assert.ok(['lavora', 'ferma'].includes(letto.stato));
  assert.equal(fs.readdirSync(dirSessione(root)).filter((f) => f.endsWith('.tmp')).length, 0,
    'nessun temporaneo lasciato indietro');
});

test('un evento PIU VECCHIO non sovrascrive uno piu recente', () => {
  // Due hook possono arrivare invertiti: il processo di un evento piu vecchio
  // puo' essere schedulato dopo quello di uno piu recente. Lo stato pubblicato
  // deve restare quello dell'evento piu recente, o la cella torna indietro.
  const root = tmpRoot();
  const dir = dirSessione(root);
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'Stop', { ora });
  evento(root, 'UserPromptSubmit', { ora: ora - 5000 });
  const letto = leggiAttivita(root, SESSIONE, ora);
  assert.equal(letto.stato, 'ferma', 'lo Stop piu recente resta');
  assert.equal(letto.ts, ora, 'il ts non torna indietro');
});

test('un lock ORFANO non blocca le scritture per sempre', () => {
  // Il lock introduce un guasto proprio: un processo ucciso dentro la sezione
  // critica lo lascia dietro. Se non fosse scavalcabile, la cella smetterebbe
  // di aggiornare lo stato — un guasto peggiore di quello che il lock ripara.
  const root = tmpRoot();
  const dir = dirSessione(root);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${NOME_FILE}.lock`);
  fs.writeFileSync(lock, '');
  const vecchio = new Date(Date.now() - 5000);
  fs.utimesSync(lock, vecchio, vecchio);
  lanciata(root);
  assert.equal(evento(root, 'Stop'), true, 'si scrive lo stesso');
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'ferma');
  assert.equal(fs.existsSync(lock), false, 'il lock orfano e stato rimosso');
});

test('scritture concorrenti VERE: vince il ts piu alto, ogni chiamata sa il proprio esito', async () => {
  // Processi figli con partenza a barriera: e' la forma in cui la concorrenza
  // accade davvero (un processo per hook). Le chiamate nello stesso thread non
  // la esercitano, perche' `scriviStato` e' sincrono.
  const root = tmpRoot();
  const dir = dirSessione(root);
  const base = 1_700_000_000_000;
  lanciata(root);
  const N = 8;
  const barriera = path.join(root, 'via');
  const figli = [];
  for (let i = 0; i < N; i += 1) {
    figli.push(spawn(process.execPath, [
      path.join(__dirname, 'fixtures', 'activity-concurrent-writer.js'),
      dir, 'UserPromptSubmit', String(base + i * 1000), barriera, path.join(root, `ready-${i}`), GEN,
    ], { stdio: ['ignore', 'pipe', 'ignore'] }));
  }
  // Fase 1: tutti schierati. Senza questa, il tempo di spawn scaglionerebbe le
  // scritture e il caso peggiore non verrebbe mai raggiunto.
  const scadenza = Date.now() + 20000;
  while (Array.from({ length: N }, (_, i) => fs.existsSync(path.join(root, `ready-${i}`))).includes(false)) {
    if (Date.now() > scadenza) throw new Error('i figli non si sono schierati in tempo');
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(barriera, 'via'); // fase 2: partenza simultanea
  const esiti = await Promise.all(figli.map((p) => new Promise((res) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => res(out));
  })));
  // Contratto: `true` = scritto; `false` = scartato davanti a un ts piu'
  // avanzato, e chi chiama LO SA. Nessun processo tace e nessuno inventa un
  // terzo esito.
  assert.ok(esiti.every((e) => e === 'ok' || e === 'persa'),
    `ogni scrittore riporta il proprio esito: ${JSON.stringify(esiti)}`);
  // Il piu' recente non puo' mai perdere: nessun concorrente ha un ts maggiore.
  assert.equal(esiti[N - 1], 'ok', 'chi scrive lo stato piu recente deve trovare il deposito libero di rivali');
  // `ora` esplicito: i ts del test sono sintetici e senza questo il lettore li
  // vedrebbe scaduti (il che non c'entra con la concorrenza).
  const letto = leggiAttivita(root, SESSIONE, base + N * 1000);
  assert.equal(letto.ts, base + (N - 1) * 1000, 'lo stato finale e quello dell evento piu recente');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0,
    'nessun temporaneo lasciato indietro');
});

// --- assenza e rottura ----------------------------------------------------

test('assente, rotto o fuori contratto -> null, mai un throw', () => {
  const root = tmpRoot();
  assert.equal(leggiAttivita(root, SESSIONE), null, 'assente');
  scriviFile(root, '{ non json');
  assert.equal(leggiAttivita(root, SESSIONE), null, 'JSON rotto');
  scriviFile(root, JSON.stringify({ event: 'Stop' }));
  assert.equal(leggiAttivita(root, SESSIONE), null, 'senza ts');
  scriviFile(root, JSON.stringify({ event: 'Stop', ts: 'ieri' }));
  assert.equal(leggiAttivita(root, SESSIONE), null, 'ts non numerico');
  scriviFile(root, JSON.stringify({ event: 'SessionEnd', ts: Date.now() }));
  assert.equal(leggiAttivita(root, SESSIONE), null, 'SessionEnd non afferma stato');
  assert.equal(leggiAttivita(root, '../etc'), null, 'nome che esce dalla root');
  assert.equal(leggiAttivita(root, ''), null);
});

test('il contratto del file non contiene il payload dell hook', () => {
  const root = tmpRoot();
  scriviGenerazione(dirSessione(root), 'g1');
  scriviStato(dirSessione(root), { evento: 'UserPromptSubmit', sessionId: 's1', generazione: 'g1' });
  const raw = JSON.parse(fs.readFileSync(path.join(dirSessione(root), NOME_FILE), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['event', 'generation', 'session_id', 'ts']);
  const gen = fs.readFileSync(path.join(dirSessione(root), NOME_GENERAZIONE), 'utf8');
  assert.equal(gen, 'g1');
});

// --- uscita del client contro uno stato nel futuro tollerato ----------------
// Uno Stop con ts nel futuro ammesso dal lettore (+2 min) restava pubblicato
// anche quando il client era morto: l'uscita scritta dal supervisore aveva un
// ts piu' vecchio e lo scrittore la scartava — dicendo però che andasse bene.
// L'uscita del client è autorevole: vince sull'ordine, e lo scarto di un
// evento è un esito (false), non un successo.

test('ClientExit vince su uno Stop nel futuro tollerato: la lettura diventa null, subito e dopo un\'ora', () => {
  const root = tmpRoot();
  const T0 = 1_700_000_000_000;
  scriviGenerazione(dirSessione(root), 'g1');
  assert.equal(scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'g1', ora: T0 + 60_000 }), true);
  assert.equal(leggiAttivita(root, SESSIONE, T0).stato, 'ferma',
    'il futuro tollerato ammette lo Stop: «ferma» finché il client vive');
  assert.equal(scriviStato(dirSessione(root), { evento: USCITA, generazione: 'g1', ora: T0 }), true,
    'l\'uscita del client è scritta, non scartata');
  assert.equal(leggiAttivita(root, SESSIONE, T0), null,
    'a T0 il client non c\'è più: nessuno «ferma»');
  assert.equal(leggiAttivita(root, SESSIONE, T0 + 60 * 60 * 1000), null,
    'a T0+1h resta null: il non-scadere di «ferma» non la rianima');
});

test('un hook più vecchio dello stato pubblicato viene SCARTATO: scriviStato risponde false', () => {
  const root = tmpRoot();
  const T0 = 1_700_000_000_000;
  lanciata(root);
  assert.equal(evento(root, 'Stop', { ora: T0 }), true);
  // Un PreToolUse in ritardo di un giro non riporta indietro lo stato, e chi
  // chiama se ne accorge: false, non un true di cortesia.
  assert.equal(evento(root, 'PreToolUse', { ora: T0 - 5_000 }), false);
  const letto = leggiAttivita(root, SESSIONE, T0);
  assert.equal(letto.stato, 'ferma', 'lo stato pubblicato resta quello piu\' recente');
  assert.equal(letto.ts, T0);
});

test('NEGATIVO: ClientExit con ts ordinato non sposta nulla: scritto con il suo ts', () => {
  const root = tmpRoot();
  const T0 = 1_700_000_000_000;
  lanciata(root);
  assert.equal(evento(root, 'UserPromptSubmit', { ora: T0 }), true);
  assert.equal(evento(root, USCITA, { ora: T0 + 1_000 }), true);
  assert.equal(leggiAttivita(root, SESSIONE, T0 + 2_000), null);
  const raw = JSON.parse(fs.readFileSync(path.join(dirSessione(root), NOME_FILE), 'utf8'));
  assert.equal(raw.ts, T0 + 1_000, 'il ts del file è quello dell\'uscita, non ripubblicato in avanti');
});

test('NEGATIVO: un evento più RECENTE dello stato pubblicato vince e risponde true', () => {
  const root = tmpRoot();
  const T0 = 1_700_000_000_000;
  lanciata(root);
  assert.equal(evento(root, 'Stop', { ora: T0 }), true);
  assert.equal(evento(root, 'SessionStart', { ora: T0 + 5_000 }), true,
    'l\'ordine vale in entrambe le direzioni: il piu\' recente scrive');
  const letto = leggiAttivita(root, SESSIONE, T0 + 6_000);
  assert.equal(letto.stato, 'ferma');
  assert.equal(letto.ts, T0 + 5_000);
});

test('NEGATIVO: un hook DOPO l\'uscita rinnova lo stato — l\'uscita non blocca per sempre', () => {
  const root = tmpRoot();
  const T0 = 1_700_000_000_000;
  scriviGenerazione(dirSessione(root), 'g1');
  assert.equal(scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'g1', ora: T0 + 60_000 }), true);
  assert.equal(scriviStato(dirSessione(root), { evento: USCITA, generazione: 'g1', ora: T0 }), true);
  // Un client rientrato (stesso lancio) emette hook con ts reali successivi:
  // la nuova attivita' deve valere — l'uscita invalida il passato, non il futuro.
  assert.equal(scriviStato(dirSessione(root), { evento: 'UserPromptSubmit', generazione: 'g1', ora: T0 + 120_000 }), true);
  assert.equal(leggiAttivita(root, SESSIONE, T0 + 130_000).stato, 'lavora');
});

// --- i due riproduttori dell'audit, e la compatibilita' col supervisore vecchio

test("riproduttore: un `Stop` SENZA generazione mentre il lancio sta partendo → null", () => {
  // E' il caso dell'audit. Durante lo spawn arriva l'ultimo evento di un client
  // che non dichiara la generazione: non deve essere letto. Non e' legato ad
  // alcun lancio, nessuno puo' invalidarlo, e con «ferma» che non scade
  // resterebbe vero per sempre su una cella appena partita.
  const root = tmpRoot();
  const dir = dirSessione(root);
  scriviGenerazione(dir, GEN, { uscitaGarantita: true }); // il lancio ha pubblicato la sua generazione
  scriviStato(dir, { evento: 'Stop', ora: Date.now() });  // hook di un client che non la dichiara
  assert.equal(leggiAttivita(root, SESSIONE), null, 'senza generazione non si legge, mai');
});

test("riproduttore: supervisore VECCHIO (senza il segno dell'uscita), `Stop` di 60 minuti → null", () => {
  // 0.9.41 e 0.9.42-dev.0 non dichiarano l'uscita del client: su un loro lancio
  // la non scadenza di «ferma» non e' garantita da niente, quindi deve tornare a
  // scadere come prima — «non verificato», non «ferma» per ore.
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root, { garantita: false });
  evento(root, 'Stop', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'ferma', 'fresco si legge');
  assert.equal(leggiAttivita(root, SESSIONE, ora + 60 * 60 * 1000), null,
    'senza la garanzia dell uscita, «ferma» scade come nella 0.9.41');
});

test("supervisore NUOVO (col segno dell'uscita): lo stesso `Stop` di 60 minuti resta «ferma»", () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'Stop', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 60 * 60 * 1000).stato, 'ferma',
    'la non scadenza vale dove l invalidazione e garantita');
});

test("l'evento di LANCIO invalida lo stato precedente: stesso lancio, e si legge null", () => {
  // Isola la regola dell'evento di lancio: generazione IDENTICA su disco e
  // nell'evento, quindi non e' il mismatch a produrre il null — e' la mappa
  // dell'evento. E' quello che rende innocuo un «ferma» lasciato dal client
  // precedente quando cell-exec fa partire il lancio.
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  lanciata(root);
  evento(root, 'Stop', { ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'ferma');
  evento(root, AVVIO, { ora: ora + 2000 });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 3000), null,
    'il lancio invalida quello che c era, senza cambiare la generazione');
  // e un hook che arriva DOPO il lancio rinnova lo stato: il lancio invalida il
  // passato, non il futuro.
  evento(root, 'UserPromptSubmit', { ora: ora + 4000 });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 5000).stato, 'lavora');
});

test('cella lanciata PRIMA di questa versione (una riga, senza marcatore): «ferma» scade a 5 minuti', () => {
  // Le celle gia' in esecuzione quando si aggiorna non hanno ne' il marcatore
  // sul pane ne' il segno `exit:1` nel file: per loro la non scadenza non e'
  // garantita da niente, quindi «ferma» torna a scadere come nella 0.9.41 —
  // «non verificato» invece di «ferma» per ore. E' la ragione per cui il
  // passaggio non lascia celle bloccate su uno stato vecchio.
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviGenerazione(dirSessione(root), 'gen-di-una-versione-vecchia');   // una riga
  scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'gen-di-una-versione-vecchia', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'ferma', 'fresco si legge');
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS + 1), null,
    'oltre la finestra: non verificato, non «ferma» per sempre');
});
