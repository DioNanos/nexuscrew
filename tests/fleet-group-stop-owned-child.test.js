'use strict';
// Fase di stop: il supervisore ferma il figlio che POSSIEDE quando quel figlio
// ha lasciato il gruppo del supervisore (job control su pty), e non dichiara
// «pronto a uscire» finche' il figlio noto non e' uscito e il censimento non e'
// vuoto. I segnali arrivano all'oggetto ChildProcess, mai a un pid preso da un
// censimento; nessuna adozione di un pid riusato, nessun segnale dopo l'uscita.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const gruppo = require('../lib/fleet/group-stop.js');

function hexId() { return crypto.randomBytes(8).toString('hex'); }

const NOTI = { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };

async function fase(opts = {}) {
  const spediti = [];
  const ordine = [];
  let clock = 0;
  const esito = await gruppo.eseguiFaseStop({
    frame: { payload: { deadlineMs: 400 }, requestId: hexId(), epoch: 1 },
    tokenHash: 'a'.repeat(64),
    launchId: hexId(),
    monoNow: () => clock,
    sleep: async (ms) => { clock += ms; },
    killGruppo: (sig) => { ordine.push(`gruppo:${sig}`); },
    osserva: opts.osserva || (() => NOTI),
    invia: (frame) => { spediti.push(frame); ordine.push(frame.op); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    ...(opts.fermaFiglioNoto ? {
      fermaFiglioNoto: async (arg) => {
        ordine.push(`figlio:${arg && Number.isFinite(arg.termMs) ? 'term-budget' : 'senza-budget'}`);
        return opts.fermaFiglioNoto(arg);
      },
    } : {}),
    ...(opts.avanza ? { avanza: opts.avanza } : {}),
  });
  return { esito, spediti, ordine, adesso: () => clock };
}

test('figlio noto fuori dal gruppo: senza la sua uscita non si dichiara pronto', async () => {
  const r = await fase({
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' }),
    fermaFiglioNoto: async () => ({ uscito: false, motivo: 'scaduta' }),
  });
  assert.notEqual(r.esito.outcome, 'ready-to-exit', JSON.stringify(r.esito));
  assert.equal(r.spediti.some((f) => f.op === 'ready-to-exit'), false, 'dichiarato pronto senza prova');
  assert.ok(r.spediti.some((f) => f.op === 'stop-report'), 'nessuna diagnosi al chiamante');
});

test('figlio noto fermato prima della dichiarazione: il pronto arriva dopo la sua uscita', async () => {
  let rilasciato = false;
  const r = await fase({
    osserva: () => (rilasciato ? NOTI : { inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' }),
    fermaFiglioNoto: async () => { rilasciato = true; return { uscito: true }; },
  });
  assert.equal(r.esito.outcome, 'ready-to-exit', JSON.stringify(r.esito));
  const iFiglio = r.ordine.indexOf('figlio:term-budget');
  const iPronto = r.ordine.indexOf('ready-to-exit');
  assert.ok(iFiglio >= 0 && iPronto > iFiglio, `pronto prima della fermata: ${r.ordine.join('>')}`);
  assert.equal(r.ordine[0], 'stop-ack');
});

test('figlio che ignora TERM: si dichiara pronto solo dopo l\'uscita vera, con un solo giro', async () => {
  let chiamate = 0;
  const r = await fase({
    osserva: () => NOTI,
    fermaFiglioNoto: async () => { chiamate += 1; return { uscito: true, escalato: true }; },
  });
  assert.equal(r.esito.outcome, 'ready-to-exit', JSON.stringify(r.esito));
  assert.equal(chiamate, 1, 'la fermata del figlio deve avvenire una volta sola');
  assert.equal(r.ordine.filter((x) => x === 'ready-to-exit').length, 1);
});

test('figlio gia\' uscito: nessun segnale aggiuntivo, il pronto non dipende da lui', async () => {
  let chiamate = 0;
  const r = await fase({
    osserva: () => NOTI,
    fermaFiglioNoto: async () => { chiamate += 1; return { uscito: true, gia: true }; },
  });
  assert.equal(r.esito.outcome, 'ready-to-exit');
  assert.equal(chiamate, 1);
});

test('permesso negato sul figlio: diagnosi e nessun pronto', async () => {
  const r = await fase({
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' }),
    fermaFiglioNoto: async () => ({ uscito: false, motivo: 'eperm' }),
  });
  assert.notEqual(r.esito.outcome, 'ready-to-exit');
  const report = r.spediti.find((f) => f.op === 'stop-report');
  assert.ok(report, 'nessun report');
  assert.equal(report.payload.code, 'eperm', JSON.stringify(report.payload));
});

test('residuo zero al primo controllo: nessun comando, esito non pulito', async () => {
  let clock = 0;
  const spediti = [];
  const esito = await (async () => {
    // Il tempo avanza dentro il primo passo (cancellaDelivery), cosi' il
    // controllo della deadline cade prima di ogni segnale.
    clock = 10 ** 6;
    return gruppo.eseguiFaseStop({
      frame: { payload: { deadlineMs: 100 }, requestId: hexId(), epoch: 1 },
      tokenHash: 'b'.repeat(64),
      launchId: hexId(),
      monoNow: () => clock,
      sleep: async () => {},
      killGruppo: () => { throw new Error('segnale oltre la deadline'); },
      osserva: () => NOTI,
      invia: (f) => { spediti.push(f); return true; },
      svuota: async () => true,
      cancellaDelivery: async () => { clock += 500; return null; },
      scriviLog: () => {},
      fermaFiglioNoto: async () => ({ uscito: true }),
    });
  })();
  assert.notEqual(esito.outcome, 'ready-to-exit');
  assert.equal(spediti.some((f) => f.op === 'ready-to-exit'), false);
});

test('nipote ancora fuori dal gruppo: il figlio uscito non basta', async () => {
  const r = await fase({
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' }),
    fermaFiglioNoto: async () => ({ uscito: true }),
  });
  assert.notEqual(r.esito.outcome, 'ready-to-exit', JSON.stringify(r.esito));
  assert.equal(r.spediti.some((f) => f.op === 'ready-to-exit'), false);
});

test('classifica: un residuo fuori gruppo dopo l\'uscita non rende pulito l\'esito', () => {
  const dopo = { inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' };
  const conPronto = gruppo.classificaEsito({ ready: { conti: NOTI }, dopo, uscito: true });
  assert.notEqual(conPronto.outcome, 'killed-clean', JSON.stringify(conPronto));
  const conImpegno = gruppo.classificaEsito({ commit: { conti: NOTI }, dopo, uscito: true });
  assert.notEqual(conImpegno.outcome, 'killed-after-escalation', JSON.stringify(conImpegno));
  const pulito = gruppo.classificaEsito({ ready: { conti: NOTI }, dopo: NOTI, uscito: true });
  assert.equal(pulito.outcome, 'killed-clean');
});

test('caso reale: uno zsh vero con gruppo proprio viene fermato e si dichiara pronto dopo', async (t) => {
  // zsh in una sessione propria (detached = capo di sessione e di gruppo):
  // gruppo diverso da quello del test, come il client interattivo su pty.
  // Il censimento e' /proc vero.
  const figlio = spawn('zsh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(figlio.pid, 'SIGKILL'); } catch (_) { /* uscito */ } });
  // Il segnale al gruppo del supervisore non si emette per davvero: qui il
  // gruppo sarebbe quello del processo di test (e del runner). Il resto del
  // caso e' reale: zsh vero, gruppo proprio, censimento su /proc, fermata
  // sull'oggetto ChildProcess e attesa dell'evento di uscita.
  const segnaliGruppo = [];
  await new Promise((r) => setTimeout(r, 150));
  const uscito = new Promise((r) => figlio.once('exit', () => r(true)));
  let figlioUscito = false;
  uscito.then(() => { figlioUscito = true; });
  let clock = 0;
  const spediti = [];
  const esito = await gruppo.eseguiFaseStop({
    frame: { payload: { deadlineMs: 4000 }, requestId: hexId(), epoch: 1 },
    tokenHash: 'c'.repeat(64),
    launchId: hexId(),
    monoNow: () => clock,
    sleep: async (ms) => { clock += Math.max(ms, 250); await new Promise((r) => setTimeout(r, 5)); },
    killGruppo: (sig) => { segnaliGruppo.push(sig); },
    osserva: (limite) => gruppo.osservaProduzioneLimitata({
      noti: figlioUscito ? [] : [{ pid: figlio.pid, exited: false }],
      limite,
      monoNow: () => clock,
    }),
    invia: (f) => { spediti.push({ ...f, figlioGiaUscito: figlioUscito }); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    fermaFiglioNoto: async ({ termMs }) => {
      if (figlioUscito) return { uscito: true, gia: true };
      figlio.kill('SIGTERM');
      const atteso = await Promise.race([
        uscito,
        new Promise((r) => setTimeout(() => r(false), termMs || 200)),
      ]);
      if (atteso) return { uscito: true };
      figlio.kill('SIGKILL');
      const fine = await Promise.race([uscito, new Promise((r) => setTimeout(() => r(false), 1000))]);
      return fine ? { uscito: true, escalato: true } : { uscito: false, motivo: 'scaduta' };
    },
  });
  // Con un /proc vero la qualita' del censimento puo' restare «ignoti» per un
  // pid transitorio illeggibile: la fase allora non dichiara pulito, ma il
  // fatto che conta e' che il figlio sia stato fermato e che la dichiarazione
  // (pronta o escalation) arrivi SOLO dopo la sua uscita.
  assert.notEqual(esito.outcome, 'stop-unknown', JSON.stringify(esito));
  assert.equal(figlioUscito, true, 'il figlio e\' ancora vivo dopo la dichiarazione');
  assert.equal(segnaliGruppo[0], 'SIGTERM', `primo segnale: ${segnaliGruppo.join(',')}`);
  assert.deepEqual(segnaliGruppo.filter((x) => x !== 'SIGTERM' && x !== 'SIGKILL'), [], 'segnali inattesi');
  const dichiarato = spediti.find((f) => f.op === 'ready-to-exit' || f.op === 'escalate-commit');
  assert.ok(dichiarato, 'nessuna dichiarazione al chiamante');
  assert.equal(dichiarato.figlioGiaUscito, true, 'dichiarato prima dell\'uscita del figlio');
  assert.equal(dichiarato.payload.conti.fuoriGruppo, 0, 'residuo dichiarato');
});

// --- la fermata del figlio posseduto presa da sola -------------------------

const { fermaFiglioPosseduto } = require('../lib/fleet/cell-exec.js');

function figlioFinto({ esceA = 'SIGTERM', eperm = false, giaUscito = false } = {}) {
  const segnali = [];
  let risolvi = () => {};
  const attesa = new Promise((r) => { risolvi = r; });
  const child = {
    _uscito: giaUscito,
    get exitCode() { return this._uscito ? 0 : null; },
    get signalCode() { return null; },
    kill(sig) {
      if (sig === 'SIGTERM' && eperm) { const e = new Error('perm'); e.code = 'EPERM'; throw e; }
      segnali.push(sig);
      if (sig === esceA) { child._uscito = true; risolvi(true); }
      return true;
    },
  };
  return { child, attesaUscita: attesa, segnali };
}

const limite = { termMs: 20, limiteMono: 200, monoNow: () => 0 };

test('fermata del figlio: TERM e uscita provata, un solo segnale', async () => {
  const { child, attesaUscita, segnali } = figlioFinto({ esceA: 'SIGTERM' });
  const r = await fermaFiglioPosseduto({ child, attesaUscita, ...limite });
  assert.deepEqual(r, { uscito: true });
  assert.deepEqual(segnali, ['SIGTERM']);
});

test('fermata del figlio: chi ignora TERM riceve KILL, e solo dopo arriva l uscita', async () => {
  const { child, attesaUscita, segnali } = figlioFinto({ esceA: 'SIGKILL' });
  const r = await fermaFiglioPosseduto({ child, attesaUscita, ...limite });
  assert.equal(r.uscito, true);
  assert.equal(r.escalato, true);
  assert.deepEqual(segnali, ['SIGTERM', 'SIGKILL']);
});

test('fermata del figlio: KILL senza uscita non vale come uscita', async () => {
  const { child, attesaUscita, segnali } = figlioFinto({ esceA: 'nessuno' });
  const r = await fermaFiglioPosseduto({ child, attesaUscita, ...limite });
  assert.equal(r.uscito, false, JSON.stringify(r));
  assert.equal(r.motivo, 'scaduta');
  assert.deepEqual(segnali, ['SIGTERM', 'SIGKILL']);
});

test('fermata del figlio: già uscito, nessun segnale', async () => {
  const { child, attesaUscita, segnali } = figlioFinto({ giaUscito: true });
  const r = await fermaFiglioPosseduto({ child, attesaUscita, ...limite });
  assert.deepEqual(r, { uscito: true, gia: true });
  assert.deepEqual(segnali, []);
});

test('fermata del figlio: permesso negato, nessun KILL', async () => {
  const { child, attesaUscita, segnali } = figlioFinto({ eperm: true });
  const r = await fermaFiglioPosseduto({ child, attesaUscita, ...limite });
  assert.equal(r.uscito, false);
  assert.equal(r.motivo, 'eperm');
  assert.deepEqual(segnali, []);
});

test('fermata del figlio: nessuna uscita osservabile, nessun segnale', async () => {
  const { child, segnali } = figlioFinto();
  const r = await fermaFiglioPosseduto({ child, attesaUscita: null, ...limite });
  assert.equal(r.uscito, false);
  assert.equal(r.motivo, 'ignoto');
  assert.deepEqual(segnali, []);
});
