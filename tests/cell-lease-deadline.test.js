'use strict';
// Fetta 2b — deadline unica D (contratto rev28 IC1, come emendato da rev29).
//
// IC1.1: esiste UNA sola deadline D per (cella, incarnazione): il bound
// persistito e l'expiry del proof SONO LO STESSO VALORE. Il test T1 lo prova
// con un clock che AVANZA a ogni lettura (step=1ms), cioè quello che un clock
// reale fa sempre: con il codice pre-IC1 le due letture di now() (bound e
// issuedAt) divergevano e il caso «proof expiry X, bound su disco < X» era
// producibile. I clock congelati delle suite storiche nascondevano il difetto
// per incidente, non per proprietà.
//
// Qui ogni test porta il tag della norma che pinna (T1..T7 del piano fetta 2b,
// vedi outbox 2026-08-26_piano-fetta2b-ic1.md). I controlli negativi «uno per
// guardia» vivono nel referto di handoff con l'output incollato.

const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { PROOF_TTL_MS } = require('../lib/fleet/lease-verifier.js');
const L = require('../lib/fleet/cell-lease.js');

const socketAperti = [];
after(() => {
  for (const s of socketAperti) { try { s.destroy(); } catch (_) { /* gia' chiuso */ } }
});

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const client = net.createConnection(port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) {
            srv.close(() => {});
            socketAperti.push(pending, client);
            resolve({ serverSide: pending, client });
          }
          else setTimeout(wait, 2);
        };
        wait();
      });
      client.once('error', reject);
    });
  });
}

function recv(client, predicate) {
  return new Promise((resolve) => {
    let buf = '';
    function cleanup() { client.removeListener('data', on); }
    function on(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) { cleanup(); resolve(msg); }
      }
    }
    client.on('data', on);
  });
}

// Clock iniettabile: step=0 -> congelato (come le suite storiche); step=N ->
// AVANZA di N ms a OGNI lettura, cioè il comportamento di Date.now() reale.
// È ilminimum che rende visibile la differenza fra «una lettura di now() per
// transazione» e «due letture coordinate» (IC1.1).
function makeClock(start, step = 0) {
  const c = { t: start, step };
  c.now = () => { c.t += c.step; return c.t; };
  return c;
}

function setup(clock) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease2bd-'));
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.now() });
  return { home, mgr };
}

const leasesDir = (home) => path.join(home, '.nexuscrew', 'run', 'cell-leases');
const readBound = (home, cellId) => JSON.parse(fs.readFileSync(path.join(leasesDir(home), `${cellId}.json`), 'utf8'));

async function openLease(mgr, cellId = 'Research', generation = 0) {
  const info = await mgr.track(cellId);
  const { serverSide, client } = await pair();
  const ok = mgr.attachInitial(cellId, serverSide, { generation });
  assert.equal(ok, true);
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
  return { info, client, proof: ack.proof, ack };
}

// --- T1: IC1.1 — il bound persistito È l'expiry del proof, stesso valore ------

test('T1 IC1.1: bound su disco === proof.expiresAt con clock che avanza a ogni lettura', async () => {
  const clock = makeClock(10_000, 1); // step=1: ogni now() avanza — come il clock reale
  const { home, mgr } = setup(clock);
  const { client, ack } = await openLease(mgr);
  const entry = readBound(home, 'Research');
  // La sonda di IC1: «proof consegnato con expiry X, bound su disco < X» deve
  // NON essere producibile. Lo è per costruzione solo se i due sono lo STESSO
  // valore (identità, non coordinazione: due valori anche uguali-per-caso
  // restano due valori).
  assert.equal(entry.graceDeadline, Number(ack.proof.expiresAt),
    `IC1.1 violata: bound=${entry.graceDeadline} expiry=${ack.proof.expiresAt} (diff ${Number(ack.proof.expiresAt) - entry.graceDeadline}ms)`);
  client.destroy();
  mgr.close();
});

test('T1 IC1.1 (reconnect): il frame lease porta un proof con expiry === bound appena persistito', async () => {
  const clock = makeClock(10_000, 1);
  const { home, mgr } = setup(clock);
  const { info, client, proof } = await openLease(mgr);
  client.destroy(); // EOF -> grace
  await new Promise((r) => setTimeout(r, 10));
  const lease = await new Promise((resolve) => {
    const c = net.createConnection(info.stablePath, () => {
      c.write(`${JSON.stringify({ type: 'reconnect', generation: 0, proof })}\n`);
    });
    recv(c, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(lease.type, 'lease');
  const entry = readBound(home, 'Research');
  assert.equal(entry.graceDeadline, Number(lease.proof.expiresAt),
    'IC1.1 violata sul reconnect: bound ed expiry del proof consegnato divergono');
  mgr.close();
});

test('T1b sonda cross-restart IC1: dopo restart nessun proof valido che il bound rifiuta (gap=0)', async () => {
  const clock = makeClock(10_000);
  const { home, mgr } = setup(clock);
  const { info, client, proof } = await openLease(mgr);
  const bound = readBound(home, 'Research').graceDeadline;
  client.destroy();
  mgr.close(); // restart del server: la map muore, il bound resta su disco
  const X = Number(proof.expiresAt);
  assert.equal(bound, X, 'precondizione della sonda: bound === expiry (T1)');
  // Prima della deadline comune: proof valido E bound che accetta.
  const mgr2 = createLeaseManager({ home, log: () => {} }, { now: () => 10_000 + 30_000 });
  await mgr2.boot();
  const prima = await new Promise((resolve) => {
    const c = net.createConnection(info.stablePath, () => {
      c.write(`${JSON.stringify({ type: 'reconnect', generation: 0, proof })}\n`);
    });
    recv(c, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(prima.type, 'lease', 'proof valido entro D: la recovery passa');
  // Il reconnect riuscito ha aperto un lease NUOVO e committato una D NUOVA:
  // la deadline corrente è quella del proof appena consegnato (e il bound su
  // disco deve ESSERLA — IC1.1). Si rilegge dal disco, non si riusa la vecchia.
  const bound2 = readBound(home, 'Research').graceDeadline;
  assert.equal(bound2, Number(prima.proof.expiresAt), 'post-reconnect: bound === expiry del proof consegnato');
  // ALLA deadline comune il proof muore col bound: stessa D (IC1.1), non due
  // finestre da tenere allineate. Se fossero due valori, esisterebbe un istante
  // in cui il proof è vivo e il bound rifiuta: la finestra vietata da IC1.
  const mgr3 = createLeaseManager({ home, log: () => {} }, { now: () => bound2 });
  await mgr3.boot();
  const alla = await new Promise((resolve) => {
    const c = net.createConnection(info.stablePath, () => {
      c.write(`${JSON.stringify({ type: 'reconnect', generation: 0, proof: prima.proof })}\n`);
    });
    recv(c, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(alla.type, 'deny', 'a D il proof consegnato muore col bound: anticipio zero (IC2.2 via IC1.1)');
  mgr2.close();
  mgr3.close();
});

// --- T2: IC1.2 — monotonia non decrescente (max) -------------------------------

test('T2 IC1.2: un back-step del clock NON fa arretrare D; il proof resta ancorato a D', async () => {
  const clock = makeClock(10_000);
  const { home, mgr } = setup(clock);
  const { client } = await openLease(mgr);
  const prima = readBound(home, 'Research').graceDeadline;
  assert.equal(prima, 10_000 + PROOF_TTL_MS);
  clock.t = 5_000; // il clock torna indietro di 5s: la proposta sarebbe 65_000
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
  const dopo = readBound(home, 'Research');
  assert.equal(dopo.graceDeadline, prima, 'IC1.2: D non arretra (max, non overwrite)');
  assert.equal(Number(ack.proof.expiresAt), prima, 'IC1.1: il proof nasce con expiry === D (quella che resta)');
  assert.equal(Number(ack.proof.issuedAt), prima - PROOF_TTL_MS, 'issuedAt = D - TTL (M6): derivato, mai letto dal clock');
  client.destroy();
  mgr.close();
});

// --- T3: IC1.4 — ACK e proof in UN SOLO frame ----------------------------------

test('T3 IC1.4: l ACK arriva come UNA riga JSON che contiene type E proof insieme', async () => {
  const clock = makeClock(10_000);
  const { mgr } = setup(clock);
  const info = await mgr.track('Research');
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial('Research', serverSide, { generation: 0 }), true);
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const primaRigaAck = await new Promise((resolve) => {
    let buf = '';
    function on(chunk) {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      client.removeListener('data', on);
      resolve(line); // la PRIMA riga: se l'ack viaggiasse senza proof, si vede qui
    }
    client.on('data', on);
  });
  const msg = JSON.parse(primaRigaAck);
  assert.equal(msg.type, 'ack');
  assert.ok(msg.proof && typeof msg.proof === 'object' && msg.proof.proof,
    'IC1.4: il frame di ack CONTIENE il proof — un ack separato puo dichiarare successo senza rotazione');
  client.destroy();
  mgr.close();
});

// --- T4: IC1.5 + M2 — il bound copre TUTTI i proof validi ----------------------

test('T4 IC1.5+M2: bound = max expiry emesso; copre il proof PIU VECCHIO ancora vivo; <=4 vivi', async () => {
  const clock = makeClock(10_000);
  const { home, mgr } = setup(clock);
  const info = await mgr.track('Research');
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial('Research', serverSide, { generation: 0 }), true);
  const proofs = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) clock.t += L.REFRESH_MS;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
    proofs.push(ack.proof);
  }
  const expiries = proofs.map((p) => Number(p.expiresAt));
  const bound = readBound(home, 'Research').graceDeadline;
  assert.equal(bound, Math.max(...expiries), 'il bound e il MASSIMO expiry emesso, non l ultimo scritto');
  // M2: con TTL 60s e refresh 20s i proof contemporaneamente vivi sono <= 4.
  const vivi = (t) => expiries.filter((x) => x > t).length;
  for (const t of [10_001, 30_000, 50_000]) {
    assert.ok(vivi(t) <= Math.ceil(PROOF_TTL_MS / L.REFRESH_MS) + 1, `M2: proof vivi a t=${t}: ${vivi(t)}`);
  }
  // Il proof PIU VECCHIO ancora valido (expiry 70_000) deve poter reconnectare:
  // proteggerè «l ultimo» lascerebbe scoperti quelli in volo (IC1.5).
  clock.t = 55_000;
  client.destroy(); // EOF -> grace (la sua deadline non abbassa il bound: eof+60 >= D)
  await new Promise((r) => setTimeout(r, 10));
  const vecchio = proofs[0];
  const esito = await new Promise((resolve) => {
    const c = net.createConnection(info.stablePath, () => {
      c.write(`${JSON.stringify({ type: 'reconnect', generation: 0, proof: vecchio })}\n`);
    });
    recv(c, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(esito.type, 'lease', 'il bound copre TUTTI i proof ancora validi, non solo l ultimo');
  mgr.close();
});

// --- T5: IC1.6 — nessun successo con D gia scaduta al commit -------------------

test('T5 IC1.6: dopo qualunque salto del clock, ogni ACK consegnato ha expiry > clock di consegna', async () => {
  const clock = makeClock(10_000);
  const { mgr } = setup(clock);
  const { client } = await openLease(mgr);
  const osservati = [];
  const drive = async () => {
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
    osservati.push({ exp: Number(ack.proof.expiresAt), a: clock.t });
  };
  await drive();
  clock.t += 200_000; // oltre la D corrente: la proposta e' morta da un pezzo
  await drive();
  clock.t -= 500_000; // back-step violento: la proposta sarebbe molto indietro
  await drive();
  for (const { exp, a } of osservati) {
    assert.ok(exp > a, `IC1.6: ACK consegnato con expiry ${exp} <= clock ${a}: successo su D scaduta`);
  }
  client.destroy();
  mgr.close();
});

// --- T7: IC3.2/IC10 — partizione per-cella vera --------------------------------

test('T7 IC3.2/IC10: il refresh di Alpha tocca SOLO i path di Alpha (tmp per-pid + rename atomico)', async () => {
  const clock = makeClock(10_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease2bd-'));
  const scritti = [];
  const fsImpl = new Proxy({}, {
    get(_, prop) {
      if (prop === 'writeFileSync' || prop === 'renameSync') {
        return (p, ...rest) => { scritti.push(`${String(prop)}:${typeof p === 'string' ? p : '<fd>'}`); return fs[prop](p, ...rest); };
      }
      return Reflect.get(fs, prop);
    },
  });
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.now(), fs: fsImpl });
  await mgr.track('Alpha');
  await mgr.track('Beta');
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial('Alpha', serverSide, { generation: 0 }), true);
  scritti.length = 0; // da qui in poi: SOLO il refresh di Alpha
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  await recv(client, (m) => m.type === 'ack' && m.proof);
  // IC3.2: verde senza CAS cross-cella perche' la partizione e' REALE: nessun
  // percorso scrive la chiave di un'altra cella. IC10: temporaneo distinto per
  // scrittore e replace atomico (renameSync) del singolo file.
  const paths = scritti.map((s) => s.split(':').slice(1).join(':'));
  assert.ok(scritti.length >= 2, 'il refresh committa: almeno tmp + rename');
  for (const p of paths) {
    assert.ok(p.includes('Alpha'), `IC3.2 rotta: il refresh di Alpha tocca "${p}"`);
  }
  assert.ok(paths.some((p) => p.endsWith('.tmp')), 'IC10: passa da un temporaneo distinto');
  assert.ok(scritti.some((s) => s.startsWith('renameSync:')), 'IC10: replace atomico del file canonico');
  client.destroy();
  mgr.close();
});

// --- T8: IC1.3 — la transazione update→persist→ACK+proof è UN solo giro --------

// IC1.3 non si prova guardando che l'ordine oggi sia giusto (T1/T3 pinnano già
// i valori e il frame): si prova rompendo l'atomicità e vedendo che qualcuno se
// ne accorge. L'osservatore è il TEMPO DI CONSEGNA: con un socket in-process
// (PassThrough, consegna sincrona nello stesso stack del write) l'ACK arriva al
// detentore NELLO STESSO task in cui il commit è avvenuto — oppure, se un
// refactor inserisce un `await` fra persist e ACK, dopo almeno un giro di event
// loop. Il clock «che passa mentre il loop gira» è un setImmediate schedulato
// PRIMA del refresh: se la transazione è indivisibile la consegna lo precede e
// il proof consegnato è vivo; se la transazione si spezza, il proof consegnato
// è già scaduto rispetto al clock di consegna — un «successo» inutilizzabile.
// ( È la stessa finestra del disco lento di IC1.6/M2, qui aperta dall'async
//   invece che dalla write: in entrambi i casi l'ACK celebra una D già morta. )
test('T8 IC1.3: ACK consegnato nello STESSO task del commit — un yield fra persist e ACK consegna un proof gia morto', async () => {
  const clock = makeClock(10_000);
  const { mgr } = setup(clock);
  await mgr.track('Research');
  const pt = new PassThrough();
  assert.equal(mgr.attachInitial('Research', pt, { generation: 0 }), true);
  // Il clock di consegna va catturato DENTRO l'handler 'data' (la consegna è
  // sincrona dentro la pt.write: dopo l'await il loop sarebbe già girato e la
  // misura avvelenata). recv si ARMA prima della write, o l'ACK sync viene
  // consegnato a nessuno.
  let consegnaClock = null;
  const ackP = recv(pt, (m) => {
    if (m.type === 'ack' && m.proof) { consegnaClock = clock.t; return true; }
    return false;
  });
  // Il «tempo che passa» per un giro di event loop. Schedulato PRIMA della
  // write del refresh: in coda davanti a qualunque setImmediate che la
  // transazione stessa possa attendere (FIFO), quindi gira comunque dentro la
  // finestra di un eventuale yield — e solo in quel caso prima della consegna.
  setImmediate(() => { clock.t += PROOF_TTL_MS + 1_000; });
  pt.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await ackP;
  assert.ok(Number(ack.proof.expiresAt) > consegnaClock,
    `IC1.3 rotta: ACK consegnato dopo almeno un giro di event loop dal commit `
    + `(proof expiry ${Number(ack.proof.expiresAt)} <= clock di consegna ${consegnaClock}): `
    + `la transazione update→persist→ACK+proof non è indivisibile`);
  pt.destroy();
  mgr.close();
});
