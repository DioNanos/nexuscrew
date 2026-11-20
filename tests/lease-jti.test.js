'use strict';

// Contratto transazionale del jti dei proof lease: un rifiuto da un gate
// puro non brucia il proof legittimo; il consumo definitivo avviene solo
// dopo un bind committato; un bind fallito prima del commit rilascia la
// prenotazione SOLO al tentativo che la possiede; dopo un bind riuscito il
// replay resta negato anche con claims perfettamente validi (stesso jti,
// proof rifirmato per la lease corrente).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createJtiRegistry } = require('../lib/fleet/lease-jti.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { loadOrCreateVerifier, signProof } = require('../lib/fleet/lease-verifier.js');

const runDir = (home) => path.join(home, '.nexuscrew', 'run');

// fs con un fallimento pilotato sulla PROSSIMA writeFileSync: il persist del
// bind throwa una volta, poi lo store torna funzionante (retry ammesso).
function makeFailingFs() {
  const state = { failNext: false };
  const fs2 = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFileSync') {
        return (...args) => {
          if (state.failNext) {
            state.failNext = false;
            throw Object.assign(new Error('write denied (test)'), { code: 'EACCES' });
          }
          return target.writeFileSync(...args);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { fs2, failNext: () => { state.failNext = true; } };
}

// fs con un esito INCERTO pilotato sulla PROSSIMA renameSync: il rename
// APPLICA l'effetto sul record e POI segnala EIO al caller (il modello del
// fault "incerto": l'esito false non dimostra l'assenza di effetti).
function makeUncertainFs() {
  const state = { failNext: false };
  const fs2 = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (...args) => {
          target.renameSync(...args);
          if (state.failNext) {
            state.failNext = false;
            throw Object.assign(new Error('rename reported EIO (test)'), { code: 'EIO' });
          }
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { fs2, failNext: () => { state.failNext = true; } };
}

function setup({ failingFs = false, uncertainFs = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leasejti-'));
  const clock = { t: 10_000 };
  const mkfs = failingFs ? makeFailingFs() : (uncertainFs ? makeUncertainFs() : null);
  const mgr = createLeaseManager(
    { home },
    {
      now: () => clock.t,
      ...(mkfs ? { fs: mkfs.fs2 } : {}),
    },
  );
  return { home, clock, mgr, mkfs };
}

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const client = net.createConnection(srv.address().port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) { srv.close(() => {}); resolve({ serverSide: pending, client }); }
          else setTimeout(wait, 2);
        };
        wait();
      });
      client.once('error', reject);
    });
  });
}

function recv(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(to); client.removeListener('data', on); }
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

// Apre il lease dal percorso di produzione e cattura il proof consegnato
// dall'ACK del refresh immediato (i claims sono gia' tutti corretti per la
// lease viva: e' il proof che un detentore onesto ripresenta al reconnect).
async function attachWithProof(mgr, cellId, clock) {
  const info = await mgr.track(cellId);
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
  return { info, client, proof: ack.proof };
}

// Proof per il kind lease, con jti ED issuedAt pilotabili: permette due
// proof diversi (expiresAt diversi) con lo STESSO jti, per provare il gate
// di replay a claims perfettamente validi.
function forgeProof(home, clock, claims, { issuedAt = null, jti = null } = {}) {
  const v = loadOrCreateVerifier({ dir: runDir(home) });
  return signProof(v, {
    generation: '0',
    // il campo firmato jti dev'essere presente nei claims; con l'opzione si
    // firma il jti voluto (due proof diversi, stesso jti, per il gate replay)
    jti: jti || '0000000000000000',
    ...claims,
    issuedAt: issuedAt == null ? clock.t : issuedAt,
  }, { now: () => clock.t, ...(jti ? { jti } : {}) });
}

function reconnect(stablePath, msg) {
  return new Promise((resolve, reject) => {
    const rc = net.createConnection(stablePath, () => {
      rc.write(`${JSON.stringify(msg)}\n`);
    });
    recv(rc, (m) => m.type === 'lease' || m.type === 'deny').then(resolve, reject);
    rc.once('error', reject);
  });
}

test('un rifiuto per generation non brucia il proof: il retry corretto con lo stesso proof e ammesso', async () => {
  const { home, clock, mgr } = setup();
  try {
    const { info, proof } = await attachWithProof(mgr, 'alpha', clock);
    // salto di generation non verificabile -> deny del gate, senza effetti
    const bad = await reconnect(info.stablePath, { type: 'reconnect', generation: 99, proof });
    assert.equal(bad.type, 'deny');
    // lo stesso proof, con la transizione legittima, deve poter riprovare
    const ok = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(ok.type, 'lease', 'retry con lo stesso proof dopo un rifiuto puro: ammesso');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('persist fallito al bind non brucia il proof: retry con store di nuovo funzionante ammesso', async () => {
  const { home, clock, mgr, mkfs } = setup({ failingFs: true });
  try {
    const { info, proof } = await attachWithProof(mgr, 'alpha', clock);
    mkfs.failNext(); // la PROSSIMA write e' il persist del bind del reconnect
    const denied = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(denied.type, 'deny', 'bind fallito prima del commit: deny senza effetti');
    // nessun ACK/proof esce su commit fallito e il jti NON resta bruciato
    const ok = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(ok.type, 'lease', 'retry con lo stesso proof a store funzionante: ammesso');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('persist incerto (rename applicato, poi EIO) non rilascia il jti: retry con lo stesso proof NEGATO', async () => {
  const { home, clock, mgr, mkfs } = setup({ uncertainFs: true });
  try {
    const { info, proof } = await attachWithProof(mgr, 'alpha', clock);
    const record = path.join(home, '.nexuscrew', 'run', 'cell-leases', 'alpha.json');
    const before = JSON.parse(fs.readFileSync(record, 'utf8'));
    clock.t += 1_000; // la prossima proposta di D supera la corrente: il record cambiera'
    mkfs.failNext(); // il rename APPLICA l'effetto e POI segnala EIO
    const denied = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(denied.type, 'deny', 'esito incerto: nessun successo esposto');
    assert.equal(denied.proof, undefined, 'nessun ACK/proof su un esito fallito o incerto');
    // il record su disco e' CAMBIATO nonostante il deny: l'assenza di effetti
    // durevoli non era dimostrata (il fault ha applicato e poi segnalato errore)
    const after = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.ok(after.graceDeadline > before.graceDeadline, 'record osservabile: effetto persistito nonostante il deny');
    // il retry con lo STESSO proof resta NEGATO: su esito incerto il jti non
    // torna in circolo (resta indisponibile finche' vive, come un consumo)
    const retry = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(retry.type, 'deny', 'esito incerto: il jti resta indisponibile, retry negato');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('replay dopo un bind riuscito resta negato anche con claims perfettamente validi (stesso jti, proof rifirmato)', async () => {
  const { home, clock, mgr } = setup();
  try {
    const { info } = await attachWithProof(mgr, 'alpha', clock);
    const st = mgr.status('alpha');
    const jti = 'abc123def4567890';
    // ammissione 1: proof firmato per la lease viva
    const first = await reconnect(info.stablePath, {
      type: 'reconnect', generation: 0,
      proof: forgeProof(home, clock, {
        kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st.leaseId,
      }, { jti }),
    });
    assert.equal(first.type, 'lease');
    // replay: proof DIVERSO (expiresAt diverso) ma STESSO jti, rifirmato per
    // la lease NUOVA: supererebbe firma e claims — deve negarlo il gate jti
    const st2 = mgr.status('alpha');
    assert.notEqual(st2.leaseId, st.leaseId);
    const replay = await reconnect(info.stablePath, {
      type: 'reconnect', generation: 0,
      proof: forgeProof(home, clock, {
        kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st2.leaseId,
      }, { jti, issuedAt: clock.t + 1 }),
    });
    assert.equal(replay.type, 'deny', 'una sola ammissione per jti, anche a claims validi');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rilascio padronale: bind fallito rimette il jti disponibile; bind riuscito mai', async () => {
  const { home, clock, mgr, mkfs } = setup({ failingFs: true });
  try {
    const { info } = await attachWithProof(mgr, 'alpha', clock);
    const st = mgr.status('alpha');
    const jti = 'fedcba0987654321';
    const claims = { kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st.leaseId };
    mkfs.failNext();
    const failed = await reconnect(info.stablePath, {
      type: 'reconnect', generation: 0,
      proof: forgeProof(home, clock, claims, { jti }),
    });
    assert.equal(failed.type, 'deny');
    // un ALTRO proof con lo stesso jti (tentativo nuovo, store funzionante)
    // e' ammesso: la prenotazione del tentativo fallito e' stata rilasciata
    const second = await reconnect(info.stablePath, {
      type: 'reconnect', generation: 0,
      proof: forgeProof(home, clock, claims, { jti, issuedAt: clock.t + 2 }),
    });
    assert.equal(second.type, 'lease', 'jti di nuovo disponibile dopo il fallimento del proprietario');
    // dopo il bind riuscito, il medesimo jti non torna disponibile mai piu'
    const st3 = mgr.status('alpha');
    const replay = await reconnect(info.stablePath, {
      type: 'reconnect', generation: 0,
      proof: forgeProof(home, clock, {
        kind: 'lease', cellId: 'alpha', launchEpoch: info.launchEpoch, leaseId: st3.leaseId,
      }, { jti, issuedAt: clock.t + 3 }),
    });
    assert.equal(replay.type, 'deny', 'commit riuscito: rilascio impossibile');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cap jti pieno di ammissioni vive: nuove prenotazioni rifiutate, le esistenti restano valide', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leasejti-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, jtiCap: 2 }, { now: () => clock.t });
  try {
    const { info } = await attachWithProof(mgr, 'beta', clock);
    const claimsFor = (leaseId) => ({ kind: 'lease', cellId: 'beta', launchEpoch: info.launchEpoch, leaseId });
    // due ammissioni riuscite con jti distinti: il registro (cap 2) e' pieno
    let st = mgr.status('beta');
    const r1 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: forgeProof(home, clock, claimsFor(st.leaseId), { jti: 'aaa1111111111111' }) });
    assert.equal(r1.type, 'lease');
    st = mgr.status('beta');
    const r2 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: forgeProof(home, clock, claimsFor(st.leaseId), { jti: 'bbb2222222222222' }) });
    assert.equal(r2.type, 'lease');
    // terzo proof con jti NUOVO: cap pieno di entry vive -> prenotazione rifiutata -> deny
    st = mgr.status('beta');
    const r3 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: forgeProof(home, clock, claimsFor(st.leaseId), { jti: 'ccc3333333333333' }) });
    assert.equal(r3.type, 'deny', 'cap pieno: la nuova prenotazione e\' rifiutata');
    // le esistenti restano valide: il replay di un jti gia\' consumato resta negato
    st = mgr.status('beta');
    const replay1 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: forgeProof(home, clock, claimsFor(st.leaseId), { jti: 'aaa1111111111111', issuedAt: clock.t + 1 }) });
    assert.equal(replay1.type, 'deny', 'consumato non scaduto: replay negato anche a cap pieno');
    // dopo la scadenza delle entry la capacita' torna riutilizzabile
    clock.t = 70_001; // oltre l'expiresAt dei proof (70000) e delle entry del registro
    st = mgr.status('beta');
    const r4 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: forgeProof(home, clock, claimsFor(st.leaseId), { jti: 'ddd4444444444444', issuedAt: clock.t }) });
    assert.equal(r4.type, 'lease', 'scadute le entry, la capacita\' e\' di nuovo disponibile');
  } finally {
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('registro jti puro: prenotazione rientrante, commit definitivo, rilascio solo del proprietario, scadenza', () => {
  const reg = createJtiRegistry({ cap: 8 });
  const now = 10_000;
  const exp = now + 60_000;

  const hold = reg.reserve('jti-1', exp, now);
  assert.ok(hold, 'prima prenotazione accolta');
  assert.equal(reg.reserve('jti-1', exp, now), null, 'prenotazione rientrante dello stesso jti: rifiutata');
  assert.equal(reg.reserve('jti-1', exp, now + 1), null, 'e resta rifiutata finche\' vive');

  // il rilascio con un token che non possiede la prenotazione e' un no-op
  const forged = { jti: 'jti-1', n: -1 };
  assert.equal(reg.release(forged), false);
  assert.ok(reg.seen('jti-1', now), 'la prenotazione sopravvive a un rilascio non padronale');

  assert.equal(reg.commit(hold), true, 'commit definitivo dal detentore');
  assert.equal(reg.commit(hold), false, 'doppio commit: no-op');
  assert.equal(reg.release(hold), false, 'un consumo non si rilascia mai');
  assert.equal(reg.reserve('jti-1', exp, now), null, 'dopo il commit il jti non torna disponibile');

  // scadenza: le entry scadute escono, il jti torna presentabile
  assert.equal(reg.seen('jti-1', exp + 1), false);
  const again = reg.reserve('jti-1', exp, exp + 1);
  assert.ok(again, 'jti scaduto: di nuovo prenotabile');
  assert.equal(reg.release(again), true, 'rilascio padronale di una prenotazione aperta');
  assert.equal(reg.seen('jti-1', exp + 2), false, 'rilascio rimosso la prenotazione');

  // cap: a registro pieno di entry valide (reserved non scadute o consumed) le
  // NUOVE prenotazioni sono rifiutate; le vive restano al loro posto, il token
  // originario resta committabile e un consumo non viene dimenticato
  const reg2 = createJtiRegistry({ cap: 2 });
  const ha = reg2.reserve('j-cap-a', exp, now);
  assert.ok(ha, 'saturazione: prima prenotazione aperta');
  assert.ok(reg2.reserve('j-cap-b', exp, now), 'seconda prenotazione: cap pieno');
  assert.equal(reg2.reserve('j-cap-c', exp, now), null, 'cap pieno: NUOVA prenotazione rifiutata');
  assert.equal(reg2.reserve('j-cap-a', exp, now), null, 'duplicato negato anche a cap pieno');
  assert.ok(reg2.seen('j-cap-a', now), 'la prenotazione aperta NON e\' stata espulsa');
  assert.ok(reg2.seen('j-cap-b', now), 'nemmeno la seconda');
  assert.equal(reg2.commit(ha), true, 'il token originario resta committabile');
  assert.equal(reg2.reserve('j-cap-a', exp, now), null, 'consumato non scaduto: replay negato');
  assert.equal(reg2.reserve('j-cap-d', exp, now), null, 'cap ancora pieno di entry valide');
  // capacita' riutilizzabile dopo la scadenza: le entry scadute escono
  const later = exp + 1;
  const hd = reg2.reserve('j-cap-d', exp + 60_000, later);
  assert.ok(hd, 'scadute le entry, la capacita\' torna riutilizzabile');
  assert.equal(reg2.release(hd), true, 'rilascio padronale della nuova prenotazione');
});
