'use strict';
// Osservazione del gruppo DOPO l'uscita provata del supervisore.
//
// La sonda a segnale zero risponde «il kernel ha ancora quel PGID?». Non e' la
// stessa domanda di «resta un processo capace di eseguire?»: un figlio uscito e
// non ancora raccolto tiene vivo il PGID, e il suo stato Z non e' un residuo.
// Quindi: sonda negativa = percorso rapido; sonda positiva = breve retry nel
// residuo della deadline, poi censimento cooperativo a tempo che conta solo i
// membri con stato NON Z/X **effettivamente letto**. Stato mancante, corrotto o
// negato non si esclude mai: resta ignoto, e ignoto non e' pulito.
//
// La vista ristretta e' il caso insidioso: se la sonda dice «c'e' un membro» e
// il censimento non ne vede nessuno, non si dichiara il vuoto — si dichiara
// ignoto. Il pulito vale solo se il censimento ha davvero visto gli zombie che
// la sonda sentiva.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const gruppo = require('../lib/fleet/group-stop.js');

const PGRP = 424242;
const PGRP_PROPRIO = 9001;
const MIO_PID = process.pid;

// /proc sintetica: nostro processo (per la guardia «gruppo proprio») e i membri
// del gruppo bersaglio, ciascuno con il proprio stato. `stato` e' il campo 3
// dello stat, quello che il kernel mette a 'Z' per un processo uscito e non
// ancora raccolto.
function proc(t, { membri = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d582-post-'));
  const scrivi = (pid, pgrp, stato) => {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'),
      `${pid} (syn) ${stato} 1 ${pgrp} ${pgrp} 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  };
  scrivi(MIO_PID, PGRP_PROPRIO, 'S');
  for (const m of membri) scrivi(m.pid, PGRP, m.stato);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

function identitaCapo(nascita = 12345) {
  // La nascita del capogruppo si legge dallo stat sintetico: stessa forma.
  return { esito: 'presente', nascita };
}

function nascitaDa(root, pid) {
  const st = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8');
  const coda = st.slice(st.lastIndexOf(')') + 2).trim().split(/\s+/);
  return Number(coda[19]);
}

// La sonda si inietta: nei casi sintetici il kernel non ha processi veri.
function sondaChe(codice) {
  const chiamate = [];
  return {
    chiamate,
    inviaSegnaleZero: (pgrp) => {
      chiamate.push(pgrp);
      if (codice) { const e = new Error(codice); e.code = codice; throw e; }
      return true;
    },
  };
}

async function osserva(root, extra = {}) {
  const capo = extra.capoPid != null ? extra.capoPid : PGRP;
  const identita = extra.identita || identitaCapo(nascitaDa(root, capo));
  return gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita,
    procRoot: root,
    deadlineAt: 2000,
    monoNow: () => 0,
    attesa: async () => {},
    ...extra.opzioni,
    ...(extra.sonda ? { inviaSegnaleZero: extra.sonda.inviaSegnaleZero } : {}),
  });
}

test('capo zombie e nessun altro membro: nessun residuo eseguibile, ma NON e\' un pulito', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }] });
  const sonda = sondaChe(null);
  const foto = await osserva(root, { sonda });
  // Uno zombie tiene vivo il PGID: la sonda resta positiva. Un censimento che
  // vede solo zombie non prova che non ci siano altri membri (vista parziale),
  // quindi non si dichiara il vuoto: si resta ignoti.
  assert.notEqual(foto.qualita, 'noti');
  assert.equal(foto.qualita, 'ignoti');
});

test('EPERM con capo zombie: la sonda non si trasforma in una prova negativa', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }] });
  // La sonda risponde EPERM: c'e' un membro che non possiamo segnalare. Il
  // censimento vede solo lo zombie, ma questo NON basta: EPERM non diventa mai
  // pulito tramite una vista parziale.
  const sonda = sondaChe('EPERM');
  const foto = await osserva(root, { sonda });
  assert.notEqual(foto.qualita, 'noti');
});

test('vista parziale con zombie visibile e membro vivo nascosto: mai pulito', async (t) => {
  // La sonda sente il gruppo; il censimento vede lo zombie ma NON il membro
  // vivo che il kernel conta. Vedere uno zombie non dimostra di aver visto
  // tutti gli altri.
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }] });
  const sonda = sondaChe(null);
  const foto = await osserva(root, { sonda });
  assert.notEqual(foto.qualita, 'noti');
  assert.equal(foto.inGruppo, 0);
});

test('capo zombie PIU\' un membro vivo: e\' un residuo, e nessuno lo ignora', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }, { pid: 424243, stato: 'S' }] });
  const sonda = sondaChe(null);
  const foto = await osserva(root, { sonda });
  assert.notEqual(foto.qualita, 'ignoti');
  assert.ok(foto.inGruppo >= 1, 'il membro vivo conta anche col capo zombie');
});

test('capo vivo: residuo certo, senza doverlo dedurre dal censimento', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'S' }] });
  const sonda = sondaChe(null);
  const foto = await osserva(root, { sonda });
  assert.notEqual(foto.qualita, 'ignoti');
  assert.ok(foto.inGruppo >= 1);
});

test('zombie raccolto durante il retry: ESRCH arriva e il gruppo e\' pulito', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }] });
  let giri = 0;
  const inviaSegnaleZero = () => {
    giri += 1;
    if (giri < 2) return true;           // primo giro: il PGID c'e' ancora
    const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e;
  };
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita: identitaCapo(nascitaDa(root, PGRP)),
    procRoot: root,
    deadlineAt: 2000,
    monoNow: () => 0,
    attesa: async () => {},
    inviaSegnaleZero,
  });
  assert.deepEqual(foto, { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' });
  assert.ok(giri >= 2, 'il retry deve aver riprovato');
});

test('lettura negata di un membro: ignoto, mai pulito', async (t) => {
  const root = proc(t, { membri: [{ pid: 424243, stato: 'S' }] });
  const sonda = sondaChe(null);
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita: identitaCapo(),
    procRoot: root,
    deadlineAt: 2000,
    monoNow: () => 0,
    attesa: async () => {},
    inviaSegnaleZero: sonda.inviaSegnaleZero,
    leggiStat: (p) => (p.endsWith('/424243/stat')
      ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      : fs.promises.readFile(p, 'utf8')),
  });
  assert.equal(foto.qualita, 'ignoti');
});

test('vista ristretta: la sonda sente un membro ma il censimento non ne vede nessuno -> ignoto', async (t) => {
  const root = proc(t, { membri: [] });  // /proc non mostra il membro che il kernel vede
  const sonda = sondaChe(null);
  const foto = await osserva(root, { sonda, identita: identitaCapo() });
  assert.equal(foto.qualita, 'ignoti', 'un censimento cieco non diventa pulito');
});

test('deadline gia\' scaduta: nessuna attesa, nessun falso pulito', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }] });
  const sonda = sondaChe(null);
  const inizio = Date.now();
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita: identitaCapo(),
    procRoot: root,
    deadlineAt: 0,
    monoNow: () => 1,
    attesa: async () => { throw new Error('non deve attendere'); },
    inviaSegnaleZero: sonda.inviaSegnaleZero,
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.ok(Date.now() - inizio < 500);
});

test('il retry non consuma tutto il tempo del censimento', async (t) => {
  const root = proc(t, { membri: [{ pid: PGRP, stato: 'Z' }, { pid: 424243, stato: 'S' }] });
  const sonda = sondaChe(null);
  let attese = 0;
  let tempo = 0;
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita: identitaCapo(nascitaDa(root, PGRP)),
    procRoot: root,
    deadlineAt: 1000,
    monoNow: () => tempo,
    // ogni retry fa passare 400 ms: con un tetto al 25% del residuo ne basta
    // uno solo, altrimenti si mangerebbe tutta la finestra del censimento
    attesa: async () => { attese += 1; tempo += 400; },
    inviaSegnaleZero: sonda.inviaSegnaleZero,
  });
  assert.ok(foto.inGruppo >= 1);
  assert.ok(attese <= 2, `retry troppo lungo: ${attese} attese`);
});

test('censimento interrotto dal budget: almeno, mai pulito', async (t) => {
  const root = proc(t, { membri: [{ pid: 424243, stato: 'S' }] });
  const sonda = sondaChe(null);
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: PGRP,
    identita: identitaCapo(),
    procRoot: root,
    deadlineAt: Date.now() + 150,
    monoNow: () => Date.now(),
    attesa: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    inviaSegnaleZero: sonda.inviaSegnaleZero,
    // una lettura che non termina: il censimento non arriva in fondo
    leggiStat: (p) => (p.endsWith('/424243/stat')
      ? new Promise(() => {})
      : fs.promises.readFile(p, 'utf8')),
  });
  assert.notEqual(foto.qualita, 'noti');
});

// --- la deadline arriva al seam, non resta implicita ------------------------

test('attendiFermataGruppo passa la deadline all\'osservazione', async () => {
  let visto = null;
  let ascolta = null;
  let chiusura = null;
  const mgr = {
    controlConnesso: () => true,
    sendControl: (id, frame) => {
      setTimeout(() => {
        if (ascolta) {
          ascolta('c', {
            op: 'escalate-commit',
            payload: { stopRequestId: frame.requestId, conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } },
          });
        }
        if (chiusura) chiusura();
      }, 0);
      return true;
    },
    ascoltaControl: (cb) => { ascolta = cb; return () => { ascolta = null; }; },
    suChiusuraControl: (id, cb) => { chiusura = cb; return () => { chiusura = null; }; },
  };
  await gruppo.attendiFermataGruppo({
    leaseManager: mgr,
    cellId: 'c',
    launchId: 'l',
    monoNow: () => 0,
    deadlineAt: 4321,
    graziaMs: 100,
    attendiUscita: async () => ({ provato: true }),
    osserva: (limite) => { visto = limite; return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }; },
  });
  assert.equal(visto, 4321, 'la deadline deve essere propagata al seam');
});

// --- un caso col kernel vero: lo zombie tiene davvero il PGID -------------

test('kernel vero: un capo zombie non raccolto tiene il PGID ma non e\' un residuo', async (t) => {
  let py = null;
  try { py = spawn('python3', ['-c', 'import os,sys,time\np=os.fork()\nif p==0:\n os.setsid()\n os._exit(0)\nsys.stdout.write(str(p));sys.stdout.flush()\ntime.sleep(8)\n'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { py = null; }
  if (!py) { t.skip('python3 non disponibile: prova sul kernel non eseguita'); return; }
  t.after(() => { try { py.kill('SIGKILL'); } catch (_) {} });
  const zombiePid = await new Promise((resolve, reject) => {
    let buf = '';
    const fine = setTimeout(() => reject(new Error('zombie non nato')), 5000);
    py.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      if (/^[0-9]+$/.test(buf.trim())) { clearTimeout(fine); resolve(Number(buf.trim())); }
    });
  });
  // Il figlio fa setsid() e poi esce: lo stato 'Z' arriva un attimo dopo la
  // fork, e il padre non lo raccoglie (e' proprio quello che lo tiene zombie).
  let id = null;
  const fine = Date.now() + 2000;
  while (Date.now() < fine) {
    id = gruppo.leggiIdentitaDa('/proc', zombiePid);
    if (id.esito === 'presente' && id.stato === 'Z') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(id && id.esito, 'presente');
  assert.equal(id.stato, 'Z', 'il figlio deve essere uno zombie');
  const foto = await gruppo.osservaGruppoDopoUscita({
    pgrp: zombiePid,
    identita: id,
    deadlineAt: Date.now() + 2000,
    monoNow: () => Date.now(),
    attesa: async () => {},
  });
  // Il PGID resta vivo finche' lo zombie non e' raccolto: la sonda non arriva
  // a ESRCH, quindi il gruppo non si dichiara vuoto.
  assert.notEqual(foto.qualita, 'noti');
  assert.equal(foto.inGruppo, 0);
});
