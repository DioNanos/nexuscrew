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
if (cfg.modo === 'muto') { setTimeout(() => {}, 60000); }
else if (cfg.modo === 'eof') { frameOk(0, String(cfg.pid)); process.exit(0); }
else if (cfg.modo === 'errore') { frameOk(0, String(cfg.pid)); frameErr(1, 'no such client'); process.exit(0); }
else if (cfg.modo === 'presente') { frameOk(0, String(cfg.pid)); frameOk(1, ''); process.exit(0); }
else { frameOk(0, String(cfg.pid)); frameErr(1, cfg.assenza || ('can\\'t find session: ' + ${JSON.stringify(SESSIONE)})); process.exit(0); }
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
  for (const vietato of ['kill-session', 'kill-server', 'send-keys', 'new-session', 'attach', 'respawn']) {
    assert.equal(argv.includes(vietato), false, `comando vietato sulla connessione nuova: ${vietato}`);
  }
});

test('un id che e\' PREFISSO di un altro non attesta ($7 contro $70)', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $70" });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false, 'il suffisso diverso non e\' il nostro target');
});

test('un id che CONTIENE il nostro numero non attesta ($7 contro $17)', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $17" });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
});

test('testo estraneo o aggiuntivo al verdetto non attesta', async (t) => {
  const finto = tmuxFinto(t, { modo: 'assenza', assenza: "can't find session: $7 — nota aggiuntiva" });
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
  const finto = tmuxFinto(t, { modo: 'errore' });
  const socket = await socketInAscolto(t);
  const r = await tmuxControl.attestaAssenzaNuovaConnessione(base(socket, { bin: finto.bin }));
  assert.equal(r.attestato, false);
  assert.equal(r.motivo, 'verdetto');
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
