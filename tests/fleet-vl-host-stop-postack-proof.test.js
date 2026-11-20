'use strict';
// Prova del kernel dopo l'ack sullo stop v2 ORDINARIO. `none` promuove a
// host-stopped-clean SOLO con un'uscita provata nel dominio REGISTRATO nel
// record e coincidente col nodo che osserva, e SOLO con budget ancora vivo
// dopo le due letture. Nessun segnale, nessuna factory di recupero, nessun
// giornale: qui il kernel e' una funzione e i figli sono EventEmitter
// sintetici.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = require('../lib/fleet/vl-host-stop.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');

const OWNER = 'cd'.repeat(16);
const BOOT = '33333333-2222-4333-8333-444444444444';
const ALTRO_BOOT = '44444444-2222-4333-8333-444444444444';
const NS = '4026533000';
const PID = 4242;
const PARTENZA = 50000;
const CAPS = ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'];

function identita(extra = {}) {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: PID,
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    bootId: BOOT,
    pidNamespaceInode: NS,
    startTicks: '1234',
    pgid: PID,
    sid: PID,
    ...extra,
  };
}

const VIVO = {
  schema_version: 1,
  state: 'live',
  declared_pid: PID,
  pid_number_in_use: true,
  capabilities: CAPS,
  peer_identity_support: 'supported',
};
const NONE = {
  schema_version: 1,
  state: 'none',
  declared_pid: null,
  pid_number_in_use: null,
  capabilities: CAPS,
  peer_identity_support: 'supported',
};
const ACK = { ok: true, reason: 'shutdown_ack' };

// Un figlio sintetico: nessun processo, nessun segnale reale. Emette la riga e
// chiude, come il doppio di ack-wait.
function proc(uscita, code = 0) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => { queueMicrotask(() => p.emit('close', null)); return true; };
  p.unref = () => {};
  queueMicrotask(() => {
    if (uscita !== undefined && uscita !== null) {
      p.stdout.emit('data', Buffer.from(typeof uscita === 'string' ? uscita : `${JSON.stringify(uscita)}\n`, 'utf8'));
    }
    p.emit('close', code);
  });
  return p;
}

// Ogni directory `recovery-events` sotto una radice, con le sue voci: la prova
// che lo stop ordinario non ha scritto ne' creato nessun giornale, in nessun
// punto della fixture.
function eventiRecovery(radice) {
  const voci = [];
  const visita = (dir, profondita) => {
    if (profondita > 8) return;
    let lista = [];
    try { lista = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const v of lista) {
      const p = path.join(dir, v.name);
      if (!v.isDirectory()) continue;
      if (v.name === 'recovery-events') {
        try { voci.push(...fs.readdirSync(p).map((n) => path.join(p, n))); } catch (_) { /* vuota */ }
        continue;
      }
      visita(p, profondita + 1);
    }
  };
  visita(radice, 0);
  return voci;
}

function crea(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-postack-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cella = 'CellaPostAck';
  const base = vlCellBaseDir(home, OWNER, cella);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const bin = path.join(root, 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  // Lo state dir del record esiste ed e' privato, come in produzione: se un
  // percorso scrivesse un giornale di recovery, lo troverebbe pronto.
  const xdgState = path.join(root, 'xdg-state');
  fs.mkdirSync(xdgState, { recursive: true, mode: 0o700 });
  fs.chmodSync(xdgState, 0o700);
  const record = {
    launchId: 'ab'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: xdgState,
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    HOME: home,
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    serverRoot: path.join(root, 'vl-root'),
    ts: 1,
    version: 2,
    hostIdentity: identita(opts.identita || {}),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, base, bin, record };
}

// Una corsa di stop sullo stop v2 ordinario: due sorgenti di comandi (status e
// stop interno) e due seam del kernel. Nessun modulo di recovery in gioco.
async function corsa(fx, opts = {}) {
  const stati = opts.stati || [VIVO, NONE];
  const nodo = Object.prototype.hasOwnProperty.call(opts, 'nodo')
    ? opts.nodo
    : () => ({ bootId: BOOT, pidNamespaceInode: NS });
  const osserva = Object.prototype.hasOwnProperty.call(opts, 'osserva')
    ? opts.osserva
    : () => ({ state: 'absent', node: { bootId: BOOT, pidNamespaceInode: NS } });
  const stopUscita = Object.prototype.hasOwnProperty.call(opts, 'stop') ? opts.stop : ACK;
  const stopCode = Object.prototype.hasOwnProperty.call(opts, 'stopCode') ? opts.stopCode : 0;
  const mod = opts.modulo || host;
  let nStatus = 0;
  let ora = PARTENZA;
  const chiamate = [];
  const stop = [];
  const osservazioni = [];
  const spawnImpl = (_bin, args) => {
    chiamate.push(args.slice());
    if (args[0] === 'host' && args[1] === 'status') {
      const i = Math.min(nStatus, stati.length - 1);
      nStatus += 1;
      return proc(stati[i]);
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      stop.push({ args: args.slice(), timeoutMs: null });
      if (typeof opts.appeso === 'function') return opts.appeso();
      return proc(stopUscita, stopCode);
    }
    if (args[0] === 'shutdown') {
      stop.push({ args: args.slice(), legacy: true });
      return proc(stopUscita, stopCode);
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  };
  const esito = await mod.fermaHost({
    record: fx.record,
    bin: fx.bin,
    budgetMs: opts.budgetMs || 3000,
    monoNow: () => ora,
    deadlineAt: PARTENZA + (opts.budgetMs || 3000),
    attesaImpl: async (ms) => { ora += Math.max(1, ms); },
    spawnImpl,
    isolamento: 'isolato',
    osservaKernel: (pid, instanceId) => {
      const letto = osserva(pid, instanceId);
      ora += opts.avanzaOsservatore || 0;
      osservazioni.push({ pid, instanceId, letto });
      return letto;
    },
    identitaNodo: () => { ora += opts.avanzaNodo || 0; return nodo(); },
  });
  return { esito, chiamate, stop, osservazioni };
}

test('positivo: assente nel dominio registrato e nodo corrente promuove pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx);
  assert.equal(r.esito.outcome, 'host-stopped-clean', 'la prova c e: lo stop chiude pulito');
  assert.equal(r.stop.length, 1, 'un solo stop');
  assert.equal(r.osservazioni.length, 1, 'una sola osservazione del pid registrato');
  assert.equal(r.osservazioni[0].pid, PID);
  assert.equal(r.osservazioni[0].instanceId, OWNER);
});

// Il budget si rilegge DOPO le due letture sincrone della prova: una prova che
// arriva a scadenza esatta o oltre non promuove, e il ciclo finisce sulla
// barriera gia' esistente. Un solo budget, quello fissato all'ack.
test('prova che esaurisce il budget nel nodo: a scadenza esatta mai pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, { avanzaNodo: 3000 });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'a scadenza esatta non si promuove');
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.equal(r.stop.length, 1, 'un solo stop');
});

test('prova che arriva alla scadenza nell osservatore: mai pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, { avanzaOsservatore: 3000 });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'la scadenza raggiunta non promuove');
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.stop.length, 1);
});

test('prova che supera la scadenza: mai pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, { avanzaOsservatore: 4000 });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'la scadenza superata non promuove');
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.stop.length, 1);
});

test('prova conclusa appena prima della scadenza: pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, { avanzaOsservatore: 2999 });
  assert.equal(r.esito.outcome, 'host-stopped-clean', 'un solo millisecondo di residuo basta alla prova');
  assert.equal(r.stop.length, 1);
});

test('negativo vivo: la stessa tupla viva in /proc non promuove mai pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, {
    osserva: (pid, instanceId) => ({
      state: 'observed',
      processState: 'S',
      identity: identita({ instanceId }),
    }),
  });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'un host vivo non e un uscita');
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.ok(r.osservazioni.length >= 1, 'il kernel e stato interrogato');
  assert.equal(r.stop.length, 1, 'nessun secondo stop');
});

test('negativo zombie: una foto observed, anche zombie, non e un uscita dopo l ack', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, {
    osserva: (pid, instanceId) => ({
      state: 'observed',
      processState: 'Z',
      identity: identita({ instanceId }),
    }),
  });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'lo zombie non e prova d uscita dopo l ack');
  assert.equal(r.esito.code, 'BARRIER');
});

test('negativo pid riusato: una nascita diversa nello stesso dominio non e un uscita', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, {
    osserva: (pid, instanceId) => ({
      state: 'observed',
      processState: 'S',
      identity: identita({ instanceId, startTicks: '99999' }),
    }),
  });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'il pid riusato resta vivo: nessuna promozione');
  assert.equal(r.esito.code, 'BARRIER');
});

test('negativo incerto: un osservazione unverifiable non promuove pulito', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, {
    osserva: () => ({ state: 'unverifiable', reason: 'io' }),
  });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'l incertezza non e un uscita');
  assert.equal(r.esito.code, 'BARRIER');
  assert.ok(r.osservazioni.length >= 1);
});

test('negativo dominio diverso: absent in un altro boot non e prova, e il nodo diverso non interroga il kernel', async (t) => {
  // (i) l'assenza dichiarata riguarda un altro mondo: non prova nulla.
  {
    const fx = crea(t);
    const r = await corsa(fx, {
      osserva: () => ({ state: 'absent', node: { bootId: ALTRO_BOOT, pidNamespaceInode: NS } }),
    });
    assert.equal(r.esito.outcome, 'host-stop-failed', 'assente in un altro boot non promuove');
    assert.equal(r.esito.code, 'BARRIER');
  }
  // (ii) il nodo che osserva non e quello registrato: nessuna osservazione.
  {
    const fx = crea(t);
    const r = await corsa(fx, { nodo: () => ({ bootId: ALTRO_BOOT, pidNamespaceInode: NS }) });
    assert.equal(r.esito.outcome, 'host-stop-failed', 'un altro nodo non promuove');
    assert.equal(r.esito.code, 'BARRIER');
    assert.deepEqual(r.osservazioni, [], 'senza dominio registrato non si interroga il kernel');
  }
});

test('negativo osservatore che lancia: l eccezione non e un uscita', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, {
    osserva: () => { throw new Error('proc illeggibile'); },
  });
  assert.equal(r.esito.outcome, 'host-stop-failed', 'una lettura che lancia non e una prova');
  assert.equal(r.esito.code, 'BARRIER');
});

test('quaranta stop consecutivi sullo stesso stateDir di cella: stesso esito e mai un giornale', async (t) => {
  const fx = crea(t);
  const esiti = [];
  for (let i = 0; i < 40; i += 1) {
    const r = await corsa(fx);
    esiti.push(r.esito.outcome);
  }
  assert.deepEqual(esiti, Array(40).fill('host-stopped-clean'), 'ogni stop chiude pulito con la prova');
  assert.equal(fs.existsSync(path.join(fx.base, 'recovery-events')), false, 'la cartella del giornale non nasce mai');
  assert.deepEqual(fs.readdirSync(fx.base), [], 'lo stateDir di cella resta vuoto');
  assert.deepEqual(eventiRecovery(fx.root), [], 'nessun giornale di recovery esiste in tutta la fixture');
});

test('timeout del CLI, nuovo tentativo e riavvio del coordinatore: il secondo tentativo non e bloccato', async (t) => {
  const fx = crea(t);
  // Il CLI dello stop non risponde: lancia lo uccide e l'esito e TIMEOUT.
  const appeso = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { queueMicrotask(() => p.emit('close', null)); return true; };
    p.unref = () => {};
    return p;
  };
  const primo = await corsa(fx, { appeso });
  assert.equal(primo.esito.outcome, 'host-stop-failed');
  assert.equal(primo.esito.code, 'TIMEOUT', 'lo stop scaduto e un timeout dichiarato');

  // Nuovo tentativo sullo stesso stato: niente e durevole, quindi non blocca.
  const secondo = await corsa(fx);
  assert.equal(secondo.esito.outcome, 'host-stopped-clean', 'il nuovo tentativo non e bloccato');

  // "Riavvio del coordinatore": istanza nuova dei moduli, stessa cella.
  const risolto = require.resolve('../lib/fleet/vl-host-stop.js');
  delete require.cache[risolto];
  const fresco = require(risolto);
  const terzo = await corsa(fx, { modulo: fresco });
  assert.equal(terzo.esito.outcome, 'host-stopped-clean', 'la nuova istanza non trova tracce da sbloccare');
});

test('rifiuto protetto: nessun ripiego, nessun secondo stop, nessuna sonda in piu', async (t) => {
  const fx = crea(t);
  const r = await corsa(fx, { stop: { ok: false, reason: 'peer_mismatch' }, stopCode: 1 });
  assert.equal(r.esito.outcome, 'host-stop-failed');
  assert.equal(r.esito.code, 'HOST_PEER_MISMATCH', 'il codice del rifiuto protetto viaggia');
  assert.equal(r.stop.length, 1, 'un solo stop');
  const dopoLoStop = r.chiamate.slice(r.chiamate.findIndex((a) => a[0] === 'internal') + 1);
  assert.deepEqual(dopoLoStop, [], 'nessun ripiego dopo il rifiuto');
});
