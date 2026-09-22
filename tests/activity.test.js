'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  leggiAttivita, scriviStato, scriviGenerazione, statoDaEvento,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS,
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
  assert.equal(statoDaEvento('Notification', 'idle_prompt'), null);
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
  for (const [evento, atteso] of casi) {
    scriviStato(dirSessione(root), { evento, sessionId: 's1' });
    const letto = leggiAttivita(root, SESSIONE);
    assert.equal(letto && letto.stato, atteso, `evento ${evento}`);
  }
});

test('Notification permission_prompt -> attesa', () => {
  const root = tmpRoot();
  scriviStato(dirSessione(root), { evento: 'Notification', tipo: 'permission_prompt' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'attesa');
});

// --- la scadenza: scaduto NON e' idle -------------------------------------

test('nessun evento oltre la finestra -> null, mai idle', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviStato(dirSessione(root), { evento: 'Stop', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS - 1).stato, 'ferma');
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS + 1), null);
});

test('un ts nel futuro oltre la tolleranza non resta fresco per sempre', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  scriviStato(dirSessione(root), { evento: 'UserPromptSubmit', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora - 1000).stato, 'lavora', 'skew piccolo tollerato');
  assert.equal(leggiAttivita(root, SESSIONE, ora - FUTURO_TOLLERATO_MS - 1000), null);
});

test('il caso Ctrl-C: nessun evento nuovo -> il dato scade invece di mentire', () => {
  const root = tmpRoot();
  const ora = 1_700_000_000_000;
  // Un turno partito e mai chiuso: misurato, Ctrl-C non emette alcun evento.
  scriviStato(dirSessione(root), { evento: 'UserPromptSubmit', ora });
  assert.equal(leggiAttivita(root, SESSIONE, ora + 1000).stato, 'lavora');
  assert.equal(leggiAttivita(root, SESSIONE, ora + MASSIMA_ETA_MS + 1), null,
    'non «ferma»: non verificato');
});

// --- generazione ----------------------------------------------------------

test('stato di una generazione precedente viene scartato', () => {
  const root = tmpRoot();
  scriviStato(dirSessione(root), { evento: 'UserPromptSubmit', generazione: 'gen-vecchia' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'lavora', 'senza generazione dichiarata vale');
  scriviGenerazione(dirSessione(root), 'gen-nuova');
  assert.equal(leggiAttivita(root, SESSIONE), null, 'la generazione corrente e gen-nuova');
  scriviStato(dirSessione(root), { evento: 'Stop', generazione: 'gen-nuova' });
  assert.equal(leggiAttivita(root, SESSIONE).stato, 'ferma');
});

// --- scrittura concorrente ------------------------------------------------

test('scritture concorrenti: il lettore non vede mai un file a meta', async () => {
  const root = tmpRoot();
  const eventi = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'];
  await Promise.all(eventi.map((evento) => Promise.resolve().then(
    () => scriviStato(dirSessione(root), { evento }))));
  const letto = leggiAttivita(root, SESSIONE);
  assert.ok(letto, 'il file resta leggibile dopo scritture concorrenti');
  assert.ok(['lavora', 'ferma'].includes(letto.stato));
  assert.equal(fs.readdirSync(dirSessione(root)).filter((f) => f.endsWith('.tmp')).length, 0,
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
