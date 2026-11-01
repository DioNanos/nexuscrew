'use strict';
// Registrazione dell'identita' del peer host ALL'UP (pezzo 2 del ciclo
// peer/stop). Il binario PINNATO viene interrogato DOPO lo spawn: la sua
// `peer_identity` dev'essere `verified` (i sette fatti kernel del peer) e la
// tuple viene PERSISTITA nel contesto del launchId con la disciplina durevole
// di scriviContesto, PRIMA che il lancio si dichiari riuscito. Senza verified
// il lancio e' fallito e visibile: nessun «isolato» dedotto da declared_pid,
// e al down un record pending NON si promuove mai (l'identita' nasce all'up
// dal binario attestante o non nasce; i record vecchi non attestati chiedono
// la procedura esplicita). Copre anche la durabilita' di scriviContesto:
// temporaneo privato, fsync del file, rename, fsync della directory e dei
// parent NUOVI, con OGNI errore propagato (nessuna falsa persistenza).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const host = require('../lib/fleet/vl-host-stop.js');
const { codeOf } = require('../lib/fleet/causes.js');

const BOOT = '12345678-1234-1234-1234-123456789abc';
const ID = 'ab'.repeat(16);

// I sette fatti kernel del peer, come li scrive il binario nel blocco
// `peer_identity` di uno status LIVE verificato (contratto VL).
function peerVerificato(extra) {
  return {
    schema_version: 1,
    state: 'verified',
    pid: 4242,
    uid: 1000,
    starttime: 1234,
    boot_id: BOOT,
    pidns: 4026531836,
    pgid: 4242,
    sid: 4242,
    ...(extra || {}),
  };
}

// La stessa tuple nella forma hostIdentity del contesto v2 (stringhe dove il
// kernel scrive decimali): e' cosi' che deve arrivare nel record.
function identitaKernel() {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: ID,
    pid: 4242,
    uid: 1000,
    bootId: BOOT,
    pidNamespaceInode: '4026531836',
    startTicks: '1234',
    pgid: 4242,
    sid: 4242,
  };
}

function procEsito(output, code) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  p.unref = () => {};
  queueMicrotask(() => {
    if (output) p.stdout.emit('data', Buffer.from(output));
    p.emit('close', code);
  });
  return p;
}

function statoLive(peer, extra) {
  return JSON.stringify({
    state: 'live',
    declared_pid: 4242,
    pid_number_in_use: true,
    capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
    peer_identity_support: 'supported',
    ...(peer !== undefined ? { peer_identity: peer } : {}),
    ...(extra || {}),
  });
}

function statoNone() {
  return '{"state":"none","capabilities":["host_stop_v1","host_peer_identity_v1","host_stop_expected_v1"],"peer_identity_support":"supported"}';
}

function baseRecord(home, bin) {
  return host.contestoIniziale({
    launchId: 'cd'.repeat(8),
    vlBin: bin,
    vlBinSha256: 'a'.repeat(64),
    XDG_STATE_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: home,
    HOME: home,
    uid: 1,
    serverRoot: path.join(home, 'root'),
    ts: 1,
  });
}

// --- identitaDaPeerIdentity: STRICT, solo verified con la tuple chiusa -----

test('unit: identitaDaPeerIdentity accetta solo verified schema 1 completo', () => {
  const h = host.identitaDaPeerIdentity(peerVerificato(), ID);
  assert.ok(h);
  assert.equal(h.state, 'live');
  assert.equal(h.source, 'kernel-peer-v1');
  assert.equal(h.instanceId, ID);
  assert.equal(h.pid, 4242);
  // i decimali del kernel diventano stringhe, come li legge leggiContesto
  assert.equal(h.startTicks, '1234');
  assert.equal(h.pidNamespaceInode, '4026531836');
  assert.equal(host.validaHostIdentity(h), null);

  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ state: 'unverified' }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ state: 'unsupported' }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ schema_version: 2 }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ sid: 0 }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ starttime: 'x' }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(peerVerificato({ boot_id: 'non-uuid' }), ID), null);
  assert.equal(host.identitaDaPeerIdentity(null, ID), null);
  assert.equal(host.identitaDaPeerIdentity([peerVerificato()], ID), null);
});

// --- profiloDaArgv: il probe ripresenta il profilo della TUI ---------------

test('unit: profiloDaArgv legge -p/--profile/--profile= e niente altro', () => {
  assert.equal(host.profiloDaArgv(['-p', 'release']), 'release');
  assert.equal(host.profiloDaArgv(['--profile', 'work']), 'work');
  assert.equal(host.profiloDaArgv(['--profile=default']), 'default');
  assert.equal(host.profiloDaArgv(['run', '-p', 'a.b-c']), 'a.b-c');
  assert.equal(host.profiloDaArgv(['run']), null);
  assert.equal(host.profiloDaArgv([]), null);
  assert.equal(host.profiloDaArgv(null), null);
  assert.equal(host.profiloDaArgv(['-p', 'nome con spazi']), null);
  assert.equal(host.profiloDaArgv(['-p', 42]), null);
  assert.equal(host.profiloDaArgv(['--profile=-lead']), null);
});

// --- registraIdentitaPeer: il ciclo all'up ---------------------------------

test('unit: up con peer verified — tuple persistita nel contesto, una sola sonda', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // stateDir con una catena NUOVA di directory: la scrittura dura crea i parent
  const stateDir = path.join(root, 'nuova', 'catena', 'ctx');
  const log = [];
  const sonde = [];
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
    record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
    spawnImpl: (b, args) => { sonde.push(args); return procEsito(statoLive(peerVerificato()) + '\n', 0); },
    attesaImpl: async () => {},
    log: (m) => log.push(m),
  });
  assert.equal(esito.ok, true);
  assert.deepEqual(esito.record.hostIdentity, identitaKernel());
  assert.ok(log.includes('host-identity-registered'));
  // una sola sonda, senza --profile (la TUI non ne aveva)
  assert.equal(sonde.length, 1);
  assert.deepEqual(sonde[0], ['host', 'status', '--json', '--server-root', '/root/vl']);
  // persistita davvero: rilegge dalla catena appena creata
  const letto = host.leggiContesto(stateDir);
  assert.ok(letto && !letto.errore, 'contesto leggibile');
  assert.deepEqual(letto.hostIdentity, identitaKernel());
});

test('unit: il profilo della TUI viaggia nella sonda di registrazione', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sonde = [];
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    stateDir: path.join(root, 'ctx'),
    record: baseRecord(root, '/pin/vl'), profile: 'work', instanceId: ID,
    spawnImpl: (b, args) => { sonde.push(args); return procEsito(statoLive(peerVerificato()) + '\n', 0); },
    attesaImpl: async () => {},
  });
  assert.equal(esito.ok, true);
  assert.deepEqual(sonde[0], ['host', 'status', '--json', '--server-root', '/root/vl', '--profile', 'work']);
});

test('unit: host VIVO senza verified — fallisce identita, NON si ritenta', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const casi = [
    ['unverified', statoLive(peerVerificato({ state: 'unverified' }))],
    ['unsupported', statoLive(peerVerificato({ state: 'unsupported' }))],
    ['assente', statoLive(undefined)],
    ['schema 2', statoLive(peerVerificato({ schema_version: 2 }))],
    ['tuple rotta', statoLive(peerVerificato({ pid: 0 }))],
  ];
  for (const [nome, out] of casi) {
    let sonde = 0;
    const stateDir = path.join(root, nome.replace(/ /g, '_'));
    const esito = await host.registraIdentitaPeer({
      bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
      record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
      spawnImpl: () => { sonde += 1; return procEsito(out + '\n', 0); },
      attesaImpl: async () => {},
    });
    assert.equal(esito.ok, false, nome);
    assert.equal(esito.motivo, 'identita', nome);
    assert.equal(sonde, 1, `${nome}: un live non verificato non si ritenta`);
    // nessuna falsa persistenza: il contesto non nasce
    assert.equal(host.leggiContesto(stateDir), null, nome);
  }
});

test('unit: host in nascita (none) — si RI-prova dentro il budget, poi ok', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const risposte = [statoNone(), statoNone(), statoLive(peerVerificato())];
  let i = 0;
  let attese = 0;
  const stateDir = path.join(root, 'ctx');
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
    record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
    spawnImpl: () => procEsito(risposte[Math.min(i++, risposte.length - 1)] + '\n', 0),
    attesaImpl: async () => { attese += 1; },
  });
  assert.equal(esito.ok, true);
  assert.equal(i, 3);
  assert.ok(attese >= 2, 'ha atteso fra i tentativi');
  assert.deepEqual(host.leggiContesto(stateDir).hostIdentity, identitaKernel());
});

test('unit: l\'host non nasce mai — budget chiuso, motivo assente, zero tuple', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sonde = 0;
  const stateDir = path.join(root, 'ctx');
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
    record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
    spawnImpl: () => { sonde += 1; return procEsito(statoNone() + '\n', 0); },
    attesaImpl: async () => {},
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'assente');
  assert.equal(sonde, host.REGISTRAZIONE_TENTATIVI);
  assert.equal(host.leggiContesto(stateDir), null);
});

test('unit: sonda mai conclusa (rc non zero) — motivo probe, nessuna tuple', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'ctx');
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
    record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
    spawnImpl: () => procEsito('', 3),
    attesaImpl: async () => {},
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'probe');
  assert.equal(host.leggiContesto(stateDir), null);
});

test('unit: contesto non scrivibile — motivo persistenza, il lancio non sale', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // stateDir occupato da un FILE: la catena durevole non puo' nascere
  const stateDir = path.join(root, 'occupato');
  fs.writeFileSync(stateDir, 'x');
  const esito = await host.registraIdentitaPeer({
    bin: '/pin/vl', env: {}, root: '/root/vl', stateDir,
    record: baseRecord(root, '/pin/vl'), profile: null, instanceId: ID,
    spawnImpl: () => procEsito(statoLive(peerVerificato()) + '\n', 0),
    attesaImpl: async () => {},
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'persistenza');
});

// --- qualificaIsolamentoHost: al down un pending NON si promuove ----------

test('unit: down di un record pending — identita ignota, NIENTE registrazione', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'ctx');
  fs.mkdirSync(stateDir, { recursive: true });
  const record = baseRecord(root, '/pin/vl'); // hostIdentity: pending
  const log = [];
  const esito = await host.qualificaIsolamentoHost({
    stateDir, record, bin: '/pin/vl', instanceId: ID,
    budgetMs: 5000, monoNow: () => Date.now(),
    spawnImpl: () => procEsito(statoLive(null) + '\n', 0),
    osservaPeer: () => identitaKernel(),
    identitaNodo: () => ({ bootId: BOOT, pidNamespaceInode: '4026531836' }),
    identitaCoordinatore: () => ({ pgid: 7, sid: 9 }),
    log: (m) => log.push(m),
  });
  assert.equal(esito.isolamento, 'ignoto');
  assert.equal(esito.motivo, 'identita');
  assert.equal(esito.record, record, 'il record resta quello: nessuna promozione');
  assert.equal(host.leggiContesto(stateDir), null, 'al down non si scrive nessuna tuple');
  assert.ok(!log.includes('host-identity-registered'));
});

test('unit: down di un record REGISTRATO all\'up — giudizio sul confronto, zero riscritture', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'ctx');
  fs.mkdirSync(stateDir, { recursive: true });
  const record = host.completaIdentita(baseRecord(root, '/pin/vl'), identitaKernel());
  assert.ok(record, 'record completo');
  const log = [];
  const esito = await host.qualificaIsolamentoHost({
    stateDir, record, bin: '/pin/vl', instanceId: ID,
    budgetMs: 5000, monoNow: () => Date.now(),
    spawnImpl: () => procEsito(statoLive(null) + '\n', 0),
    osservaPeer: () => identitaKernel(),
    identitaNodo: () => ({ bootId: BOOT, pidNamespaceInode: '4026531836' }),
    identitaCoordinatore: () => ({ pgid: 7, sid: 9 }),
    log: (m) => log.push(m),
  });
  assert.equal(esito.isolamento, 'isolato');
  assert.equal(esito.motivo, 'isolato');
  assert.equal(esito.record, record);
  assert.equal(host.leggiContesto(stateDir), null, 'il down non riscrive il contesto');
  assert.ok(!log.includes('host-identity-registered'));
});

// --- scriviContesto: durabilita' e nessuna falsa persistenza --------------

test('unit: scriviContesto crea e rende durevoli i parent NUOVI della catena', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'a', 'b', 'c'); // NON esiste
  const file = host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'));
  assert.equal(file, path.join(stateDir, 'host-context.json'));
  const letto = host.leggiContesto(stateDir);
  assert.ok(letto && !letto.errore);
  assert.equal(letto.hostIdentity.state, 'pending');
  // nessun temporaneo abbandonato nella catena
  for (const d of [stateDir, path.dirname(stateDir), path.dirname(path.dirname(stateDir))]) {
    assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp-')), []);
  }
});

test('unit: errore di scrittura (EIO) — propaga, pulisce il temporaneo, niente file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'ctx');
  fs.mkdirSync(stateDir, { recursive: true });
  const eio = () => { const e = new Error('eio'); e.code = 'EIO'; return e; };
  const impl = {
    ...fs,
    writeFileSync: (fd, data) => { throw eio(); },
  };
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO');
  assert.equal(fs.existsSync(path.join(stateDir, 'host-context.json')), false);
  assert.deepEqual(fs.readdirSync(stateDir), []);
});

test('unit: fsync della DIRECTORY che fallisce (EIO) — l\'errore sale, nessuna persistenza dichiarata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'ctx');
  fs.mkdirSync(stateDir, { recursive: true });
  const SENTINEL = { fdDi: 'directory' };
  const eio = () => { const e = new Error('eio'); e.code = 'EIO'; return e; };
  const impl = {
    ...fs,
    openSync: (p, flags, mode) => (p === stateDir ? SENTINEL : fs.openSync(p, flags, mode)),
    fsyncSync: (fd) => { if (fd === SENTINEL) throw eio(); return fs.fsyncSync(fd); },
    closeSync: (fd) => { if (fd !== SENTINEL) fs.closeSync(fd); },
  };
  // il file viene rinominato, ma la durabilita' della directory NON e' data:
  // l'errore deve salire al chiamante, che non puo' dichiarare persistenza.
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO');
});

// --- La catena si RIQUALIFICA a ogni scrittura (audit finale F1-02) --------
// L'esistenza di una directory non attesta un fsync riuscito: una catena
// superstite a un EIO (o creata a meta' da un'istanza precedente) si
// ri-sincronizza per intero, dal confine `.nexuscrew` al stateDir, e il
// fallimento sale fino al rifiuto dell'up. Un file leggibile dopo il rename
// non e' una prova di persistenza.

// fs reale + iniezione EIO per PATH sui fsync, con registro delle chiamate:
// registra ogni fsync come percorso (file temporaneo compreso), cosi' si
// prova non solo che un fsync e fallito, ma quali anelli sono stati davvero
// sincronizzati.
function implFsyncSuPath(guasti) {
  const fdPath = new Map();
  const registra = [];
  const eio = () => { const e = new Error('eio'); e.code = 'EIO'; return e; };
  const impl = {
    ...fs,
    openSync: (p, flags, mode) => {
      const fd = fs.openSync(p, flags, mode);
      if (typeof p === 'string') fdPath.set(fd, p);
      return fd;
    },
    fsyncSync: (fd) => {
      const p = fdPath.get(fd);
      if (p != null) {
        registra.push(p);
        if (guasti.has(p)) throw eio();
      }
      return fs.fsyncSync(fd);
    },
    closeSync: (fd) => { fdPath.delete(fd); return fs.closeSync(fd); },
  };
  return { impl, registra };
}

function catenaNc(root) {
  const home = path.join(root, 'home');
  const nexus = path.join(home, '.nexuscrew');
  const cells = path.join(nexus, 'vl-cells');
  const stateDir = path.join(cells, 'ab'.repeat(16) + '-CellaPre');
  return { home, nexus, cells, stateDir };
}

test('unit: catena NC esistente con EIO persistente sul parent — il retry NON riesce', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stateDir, cells } = catenaNc(root);
  fs.mkdirSync(stateDir, { recursive: true }); // catena superstite a un errore
  const { impl, registra } = implFsyncSuPath(new Set([cells]));
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO',
    'il parent ancora guasto si ri-tenta subito');
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO',
    'il retry sulla stessa catena esistente non riusce per esistenza');
  assert.ok(registra.filter((p) => p === cells).length >= 2, 'il fsync del parent guasto e stato ri-tentato');
  assert.equal(fs.existsSync(path.join(stateDir, 'host-context.json')), false, 'nessuna persistenza dichiarata');
});

test('unit: catena NC esistente sana — OGNI anello si qualifica a ogni scrittura', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { home, nexus, cells, stateDir } = catenaNc(root);
  fs.mkdirSync(stateDir, { recursive: true });
  const { impl, registra } = implFsyncSuPath(new Set());
  host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl);
  const fsyncati = new Set(registra);
  for (const anello of [nexus, cells, stateDir]) {
    assert.ok(fsyncati.has(anello), `fsync dell'anello ${path.basename(anello)}`);
    assert.ok(fsyncati.has(path.dirname(anello)), `entry nel parent di ${path.basename(anello)}`);
  }
  assert.ok(fsyncati.has(home), 'il confine .nexuscrew si sincronizza anche nel proprio parent');
  assert.equal(host.leggiContesto(stateDir).hostIdentity.state, 'pending');
});

test('unit: EIO transitorio sul parent NC — la riuscita arriva SOLO dopo il fsync effettivo', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { cells, stateDir } = catenaNc(root);
  fs.mkdirSync(stateDir, { recursive: true });
  const guasti = new Set([cells]);
  const { impl, registra } = implFsyncSuPath(guasti);
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO');
  guasti.delete(cells); // il guasto passa
  host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl);
  const primo = registra.indexOf(cells);
  const secondo = registra.indexOf(cells, primo + 1);
  assert.ok(primo >= 0 && secondo > primo, 'il parent e stato fsync-ato DAVVERO nella corsa riuscita');
  assert.equal(host.leggiContesto(stateDir).hostIdentity.state, 'pending');
});

test('unit: albero NC creato a meta\' — la nuova istanza qualifica TUTTA la catena, anelli preesistenti compresi', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { nexus, cells, stateDir } = catenaNc(root);
  fs.mkdirSync(cells, { recursive: true }); // manca solo l'ultimo anello
  const { impl, registra } = implFsyncSuPath(new Set());
  host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl);
  const fsyncati = new Set(registra);
  assert.ok(fsyncati.has(stateDir) && fsyncati.has(cells), 'l\'anello nuovo e il suo parent');
  assert.ok(fsyncati.has(nexus), 'anche l\'anello PREESISTENTE si riqualifica: la sua esistenza non attesta il fsync');
  assert.ok(fsyncati.has(path.dirname(nexus)), 'entry del confine nel parent');
});

test('unit: catena arbitraria fuori dal confine NC — il parent guasto si ri-tenta al retry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = path.join(root, 'x', 'a', 'b');
  const stateDir = path.join(b, 'c');
  fs.mkdirSync(stateDir, { recursive: true });
  const { impl } = implFsyncSuPath(new Set([b]));
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO',
    'il primo tentativo fallisce sul parent');
  assert.throws(() => host.scriviContesto(stateDir, baseRecord(root, '/pin/vl'), impl), (e) => e.code === 'EIO',
    'il retry non riusce senza ri-tentare il parent guasto');
});

// --- causes: il nuovo esito sta nell'enum chiuso ---------------------------

test('unit: VL_PEER_UNATTESTED e un codice bounded delle cause up', () => {
  assert.equal(codeOf('VL_PEER_UNATTESTED'), 'VL_PEER_UNATTESTED');
});

