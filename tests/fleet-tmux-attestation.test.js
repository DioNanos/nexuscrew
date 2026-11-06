'use strict';
// Attestazione di assenza su una connessione NUOVA, di sola lettura, dopo un
// teardown la cui risposta si e' persa.
//
// Il client nuovo puo' fare due sole cose: identificare il server e chiedere
// has-session. Deve valere solo sulla STESSA incarnazione del server del
// lancio (pid + nascita congelati prima dello stop), con l'id esatto della
// sessione, e solo un verdetto negativo specifico e completo attesta.
// EOF, timeout, connessione rifiutata, errore generico, istanza sostituita e
// identita' non verificabile NON attestano. E senza un server in ascolto non
// si avvia nemmeno il client: la creazione falserebbe il verdetto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tmuxControl = require('../lib/fleet/tmux-control.js');

const SESSIONE = '$7';
const SERVER = 4242;
const NASCITA = 777;

// tmux finto: risponde ai due comandi del client di attestazione secondo un
// file di configurazione, e registra OGNI invocazione (argv completo) cosi' un
// test puo' provare che non e' stato chiesto niente di distruttivo e che in
// certi casi il client non e' proprio partito.
function tmuxFinto(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-attest-'));
  const cfgPath = path.join(dir, 'cfg.json');
  const logPath = path.join(dir, 'invocazioni.log');
  fs.writeFileSync(cfgPath, JSON.stringify({
    pid: SERVER, modo: 'assente', ...cfg,
  }));
  fs.writeFileSync(logPath, '');
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const scrivi = (s) => process.stdout.write(s);
const frameOk = (n, testo) => scrivi('%begin 1 ' + n + ' 1\\n' + (testo ? testo + '\\n' : '') + '%end 1 ' + n + ' 1\\n');
const frameErr = (n, testo) => scrivi('%begin 1 ' + n + ' 1\\n' + testo + '\\n%error 1 ' + n + ' 1\\n');
// FEDELTA' AL VERO: tmux esegue i comandi nell'ordine dell'argv e si FERMA
// al primo che fallisce. I frame seguono l'argv, non l'ordine che il codice
// si aspetta: cosi' un ordine sbagliato si vede subito.
if (cfg.modo === 'muto') { setTimeout(() => {}, 60000); }
else if (cfg.modo === 'eof') { frameOk(0, String(cfg.pid)); process.exit(0); }
else {
  frameOk(0, String(cfg.pid));
  let n = 1;
  let fermo = false;
  for (const tok of process.argv.slice(2)) {
    if (tok === 'has-session') {
      if (cfg.modo === 'presente') frameOk(n, '');
      else {
        frameErr(n, cfg.modo === 'errore'
          ? 'no such client'
          : (cfg.assenza || ('can\\'t find session: ' + ${JSON.stringify(SESSIONE)})));
        fermo = true;
      }
      n += 1;
    } else if (tok === 'list-sessions') {
      if (cfg.elencoErrore) { frameErr(n, 'no such client'); fermo = true; }
      else frameOk(n, (cfg.elenco || []).join('\\n'));
      n += 1;
    }
    if (fermo) break;
  }
  process.exit(0);
}
`, { mode: 0o755 });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    bin,
    invocazioni: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((r) => JSON.parse(r)),
    cfgPath,
  };
}

// Un socket unix vero: l'attestazione pretende che qualcuno sia in ascolto.
async function socketInAscolto(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-attest-sock-'));
  const percorso = path.join(dir, 'sock');
  const srv = net.createServer(() => {});
  await new Promise((resolve) => srv.listen(percorso, resolve));
  t.after(() => new Promise((resolve) => { srv.close(resolve); fs.rmSync(dir, { recursive: true, force: true }); }));
  return percorso;
}

function base(socket, extra = {}) {
  return {
    tmuxBin: extra.bin,
    socket,
    sessionId: SESSIONE,
    serverPid: SERVER,
    serverStarttime: NASCITA,
    deadlineAt: Date.now() + 2000,
    monoNow: () => Date.now(),
    leggiStarttimeProc: () => NASCITA,
    ...extra,
  };
}

// --- morte verificata della stessa incarnazione del server ------------------

function incarnazione(stato) {
  return { leggiIdentitaProc: () => stato };
}

test('incarnazione morta (numero sparito): attesta senza chiedere al socket', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base('/tmp/non-esiste-mai.sock', {
    bin: finto.bin, ...incarnazione({ esito: 'assente', nascita: null }),
  }));
  assert.equal(r.attestato, true);
  assert.equal(r.motivo, 'incarnazione-morta');
  assert.deepEqual(finto.invocazioni(), [], 'nessun client su un server morto');
});

test('pid riutilizzato con nascita diversa: la vecchia incarnazione e\' finita', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base('/tmp/non-esiste-mai.sock', {
    bin: finto.bin, ...incarnazione({ esito: 'presente', nascita: NASCITA + 1 }),
  }));
  assert.equal(r.attestato, true);
  assert.equal(r.motivo, 'incarnazione-morta');
  assert.deepEqual(finto.invocazioni(), [], 'nessuna azione sul processo nuovo');
});

test('lettura negata dell\'incarnazione: non attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  for (const stato of [{ esito: 'indeterminata', nascita: null }, null, { esito: 'presente', nascita: null }]) {
    const r = await tmuxControl.attestaAssenzaNuovaConnessione(base('/tmp/non-esiste-mai.sock', {
      bin: finto.bin, ...incarnazione(stato),
    }));
    assert.equal(r.attestato, false, `stato ${JSON.stringify(stato)}`);
  }
  assert.deepEqual(finto.invocazioni(), []);
});

test('nascita iniziale mancante o non numerica: non attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  for (const nascita of [null, undefined, 'x']) {
    const r = await tmuxControl.attestaAssenzaNuovaConnessione(base('/tmp/non-esiste-mai.sock', {
      bin: finto.bin, serverStarttime: nascita,
    }));
    assert.equal(r.attestato, false, `nascita ${String(nascita)}`);
  }
});

test('server VIVO con socket irraggiungibile: non attesta (l\'irraggiungibilita\' non e\' morte)', async (t) => {
  // Il file del socket c'e' (lstat passa) ma nessuno risponde alla connessione:
  // e' il caso che l'irraggiungibilita' non deve promuovere a morte.
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
    bin: finto.bin,
    leggiIdentitaProc: () => ({ esito: 'presente', nascita: NASCITA }),
    connetti: async () => false,
  }));
  assert.equal(r.attestato, false);
  assert.equal(r.motivo, 'server-assente');
});

test('server vivo e VUOTO: l\'enumerazione completa attesta l\'assenza', async (t) => {
  // Caso reale di un nodo con una sola cella e exit-empty off: has-session
  // risponde «no current target», ma il server enumera le sue sessioni e non
  // c'e' la nostra. Enumerazione completa su istanza verificata = assenza.
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: 'no current target', elenco: [] });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
    bin: finto.bin,
    leggiIdentitaProc: () => ({ esito: 'presente', nascita: NASCITA }),
  }));
  assert.equal(r.attestato, true);
  assert.equal(r.motivo, 'enumerazione');
});

test('enumerazione COMPLETA con altre sessioni: la nostra assente attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: 'no current target', elenco: ['$1', '$2'] });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, true);
  assert.equal(r.motivo, 'enumerazione');
});

test('enumerazione parziale o malformata: non attesta', async (t) => {
  const socket = await socketInAscolto(t);
  for (const elenco of [['$1', 'spazzatura'], ['$7x'], ['non-un-id']]) {
    const finto = tmuxFinto(t, { modo: 'assenza', assenza: 'no current target', elenco });
    const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
    assert.equal(r.attestato, false, `elenco ${JSON.stringify(elenco)}`);
  }
});

test('enumerazione che CONTIENE il nostro id non attesta (contraddizione con has-session)', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: 'no current target', elenco: ['$7'] });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('elenco oltre CAP_FRAME con il target in coda: troncato, non attesta', async (t) => {
  // Controprova: 12.000 id piu' il nostro in coda superano il tetto
  // del frame (64 KiB). Il canale tronca l'elenco ma lo dichiara completo, e
  // senza il target nella parte letta si attestava l'assenza: falso pulito.
  const elenco = Array.from({ length: 12000 }, (_, i) => '$' + (10000 + i));
  elenco.push(SESSIONE);
  const finto = tmuxFinto(t, { modo: 'errore', elenco });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false, 'un elenco troncato non prova l\'assenza del target');
});

test('elenco grande ma INTERO: se il target non c\'e\', attesta', async (t) => {
  const elenco = Array.from({ length: 7000 }, (_, i) => '$' + (20000 + i));
  const finto = tmuxFinto(t, { modo: 'errore', elenco, assenza: 'no current target' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, true, 'un elenco intero senza il target e\' una prova');
  assert.equal(r.motivo, 'enumerazione');
});

test('enumerazione in errore: non attesta, nemmeno se has-session tace', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: 'no current target', elencoErrore: true });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('la morte dell\'incarnazione non invia segnali a nessuno', async (t) => {
  const chiamate = [];
  const vero = process.kill;
  process.kill = (pid, sig) => { chiamate.push([pid, sig]); throw new Error('mai'); };
  t.after(() => { process.kill = vero; });
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base('/tmp/non-esiste-mai.sock', {
    bin: tmuxFinto(t, { modo: 'assente' }).bin,
    ...incarnazione({ esito: 'assente', nascita: null }),
  }));
  assert.equal(r.attestato, true);
  assert.deepEqual(chiamate, []);
});

test('sessione assente, stessa incarnazione: attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, true);
});

test('solo due comandi di lettura: nessun kill, nessun invio, nessuna creazione', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  const invocazioni = finto.invocazioni();
  assert.equal(invocazioni.length, 1);
  const argv = invocazioni[0].join(' ');
  assert.match(argv, /-C display-message/);
  assert.match(argv, /has-session -t \$7/);
  assert.match(argv, /list-sessions -F #\{session_id\}/);
  for (const vietato of ['kill-session', 'kill-server', 'send-keys', 'new-session', 'attach', 'respawn']) {
    assert.equal(argv.includes(vietato), false, `comando vietato sulla connessione nuova: ${vietato}`);
  }
});

test('un id che e\' PREFISSO di un altro non attesta ($7 contro $70)', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $70", elencoErrore: true });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false, 'il suffisso diverso non e\' il nostro target');
});

test('un id che CONTIENE il nostro numero non attesta ($7 contro $17)', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $17", elencoErrore: true });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('testo estraneo o aggiuntivo al verdetto non attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $7 — nota aggiuntiva", elencoErrore: true });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('grammatica del verdetto: solo il target ESATTO, nessuna sottostringa', () => {
  const v = tmuxControl.verdettoAssenzaTarget;
  assert.equal(v("can't find session: $7", '$7'), true);
  assert.equal(v("  can't find session: $7  ", '$7'), true);
  assert.equal(v("can't find session: $70", '$7'), false);
  assert.equal(v("can't find session: $17", '$7'), false);
  assert.equal(v("can't find session: $7x", '$7'), false);
  assert.equal(v("can't find session: $7\nno such client", '$7'), false);
  assert.equal(v('no such client', '$7'), false);
  assert.equal(v("can't find session: 7", '$7'), false);
  assert.equal(v("can't find session: $7", '$70'), false);
  assert.equal(v(null, '$7'), false);
});

test('sessione presente: nessun falso successo', async (t) => {
  const finto = tmuxFinto(t, { modo: 'presente' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
  assert.equal(r.motivo, 'presente');
});

test('server sostituito allo stesso path: il pid non e\' quello del lancio -> nessuna attestazione', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente', pid: 999999 });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
  assert.equal(r.motivo, 'identita');
});

test('identita\' del server non verificabile: nessuna attestazione e nessun client avviato', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
    bin: finto.bin, leggiStarttimeProc: () => 123456,
  }));
  assert.equal(r.attestato, false);
  assert.equal(r.motivo, 'identita');
  assert.deepEqual(finto.invocazioni(), [], 'il client non deve partire senza identita verificata');
});

test('server morto (socket non in ascolto): nessuna attestazione e NESSUNA creazione', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-attest-morto-'));
  const socket = path.join(dir, 'sock');
  // File di socket senza ascoltatore: e' il caso in cui un client tmux
  // avvierebbe un server nuovo.
  const srv = net.createServer(() => {});
  await new Promise((resolve) => srv.listen(socket, resolve));
  await new Promise((resolve) => srv.close(resolve));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
  assert.deepEqual(finto.invocazioni(), [], 'nessun server deve essere creato, nemmeno dal client');
});

test('EOF prima del verdetto: nessuna attestazione', async (t) => {
  const finto = tmuxFinto(t, { modo: 'eof' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('timeout: nessuna attestazione e la connessione rientra dal budget', async (t) => {
  const finto = tmuxFinto(t, { modo: 'muto' });
  const socket = await socketInAscolto(t);
  const inizio = Date.now();
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
    bin: finto.bin, deadlineAt: Date.now() + 200,
  }));
  assert.equal(r.attestato, false);
  assert.ok(Date.now() - inizio < 2000, 'la connessione deve chiudersi entro il budget');
});

test('errore generico del server: non e\' il verdetto di assenza', async (t) => {
  const finto = tmuxFinto(t, { modo: 'errore', elencoErrore: true });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
  // L'enumerazione viene prima: se fallisce, la sequenza si ferma li' e il
  // verdetto non arriva. Nessuna attestazione, e il motivo e' la fine della
  // connessione, non un verdetto generico.
  assert.equal(r.motivo, 'eof');
});

test('deadline gia\' spesa: nessun client', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
    bin: finto.bin, deadlineAt: Date.now() - 1,
  }));
  assert.equal(r.attestato, false);
  assert.deepEqual(finto.invocazioni(), []);
});

test('id non valido o assente: nessun client', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assente' });
  const socket = await socketInAscolto(t);
  for (const sessionId of ['prova', '', '$', null]) {
    const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, {
      bin: finto.bin, sessionId,
    }));
    assert.equal(r.attestato, false, `id ${String(sessionId)}`);
  }
  assert.deepEqual(finto.invocazioni(), []);
});
