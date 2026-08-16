'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadDefinitions, atomicWrite, aggiornaDefinizioni,
} = require('../lib/fleet/definitions.js');

// ---------------------------------------------------------------------------
// Dove il lock di `aggiornaDefinizioni` può fare più danno del difetto che
// cura. Il lock gira nel bootstrap: lì un difetto non degrada, impedisce
// l'avvio.
//
// STORIA: la prima versione (fae12bc) cedeva in tre punti, provati da questi
// stessi test in forma rossa: esproprio del lock di un vivo (mutua esclusione
// rotta -> perdita di scrittura), busy-wait senza SharedArrayBuffer, throw
// dalla trasforma che saliva fino al bootstrap. 77cff4e li ha chiusi: questi
// test ora PINNANO il nuovo contratto — il fallimento di uno di essi vuol
// dire che una delle cure è regredita.
//
// AMBITO DICHIARATO (le cose che questi test NON stabiliscono):
// - O_EXCL su filesystem di rete/overlay: non riproducibile su questo nodo
//   (ext4/tmpfs). «Non stabilito», non «sembra a posto».
// - Termux: non eseguito qui. «Non stabilito».
// ---------------------------------------------------------------------------

// Engine/celle minime valide per parseDefinitions STRICT di atomicWrite.
function validDef(cells) {
  return {
    schemaVersion: 1,
    engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
    cells: cells || [{ id: 'Base', cwd: '/tmp', engine: 'sh' }],
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-edges-'));
const cellIds = (defs) => (defs ? defs.cells.map((c) => c.id).sort() : null);

// Un proprietario VERO, vivo, non questo processo: kill(pid, 0) deve poter
// dire «esiste» a chi consulta il lock. Muore da sé dopo un po'; il test lo
// spegne comunque per non lasciare nulla in giro.
function figlioVivo() {
  const figlio = spawn('sleep', ['10'], { stdio: 'ignore' });
  return {
    pid: figlio.pid,
    spegni: () => { try { figlio.kill('SIGKILL'); } catch (_) { /* già andato */ } },
  };
}

// Lock nel formato reale «pid:token», con l'età che si vuole simulare.
function lockConPid(p, pid, etaMs) {
  fs.writeFileSync(`${p}.lock`, `${pid}:deadbeefdeadbeef\n`, { mode: 0o600 });
  if (etaMs !== undefined) {
    const t = (Date.now() - etaMs) / 1000;
    fs.utimesSync(`${p}.lock`, t, t);
  }
}

const PID_MORTO = 999999999; // non assegnato: kill(pid,0) -> ESRCH, non EPERM

function nessunResiduo(dir, p) {
  const residui = fs.readdirSync(dir).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp'));
  assert.deepEqual(residui, [], `residui inattesi: ${residui.join(', ')}`);
}

test('baseline: senza contesa il lock fa letti-modifica-scrivi e NON lascia residui', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Nuova', cwd: '/tmp', engine: 'sh' }]));
    assert.ok(out, 'deve tornare le definizioni risultanti');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'Nuova'], 'la cella è su disco');
    nessunResiduo(dir, p); // lock rilasciato, nessun temporaneo orfano
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA 77cff4e#1: lock di 31s intestato a un processo VIVO non viene più espropriato — si attende e si rinuncia', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const altro = figlioVivo();
  try {
    atomicWrite(p, validDef());
    lockConPid(p, altro.pid, 31000); // scaduto per età, ma il proprietario ESISTE
    const contenutoPrima = fs.readFileSync(`${p}.lock`, 'utf8');
    const messaggi = [];
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]), {
      log: (m) => messaggi.push(m),
    });
    const durata = Date.now() - inizio;

    // Prima della cura: entrava in 7ms scrivendo dentro il lock del vivo.
    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia: torna lo stato corrente');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(durata >= 1800, `ha atteso fino a scadenza (durata ${durata}ms), non ha rubato`);
    assert.deepEqual(messaggi, ['definizioni fleet: lock non ottenuto, aggiornamento rimandato']);
    assert.equal(fs.readFileSync(`${p}.lock`, 'utf8'), contenutoPrima,
      'il lock del vivo non è stato toccato: né rimosso, né riscritto');
  } finally {
    altro.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA 77cff4e#1 (conseguenza): lo scenario che prima perdeva la scrittura ora degrada senza toccare nulla', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const p1 = figlioVivo();
  try {
    atomicWrite(p, validDef());
    // P1: processo vivo e lento, tiene il lock da 31s e ha GIÀ letto dentro il
    // lock. Con fae12bc qui P2 rubava e la scrittura di P2 finiva nel nulla.
    lockConPid(p, p1.pid, 31000);
    const lettoDaP1 = loadDefinitions(p);

    // P2: arriva, vede il lock di un vivo, aspetta, rinuncia.
    const messaggi = [];
    aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'DiP2', cwd: '/tmp', engine: 'sh' }]), {
      log: (m) => messaggi.push(m),
    });

    // P1: completa la sua lettura-modifica-scrivi, indisturbato.
    atomicWrite(p, validDef([...lettoDaP1.cells, { id: 'DiP1', cwd: '/tmp', engine: 'sh' }]));

    // Nessuna scrittura persa: quella di P1 c'è tutta, e il rimando di P2 è
    // registrato (chiave: prima della cura il rimando era invisibile E la
    // scrittura di P2 veniva cancellata).
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'DiP1'], 'la scrittura di P1 è integra');
    assert.ok(messaggi.length === 1 && messaggi[0].includes('lock non ottenuto'),
      'la rinuncia di P2 è dichiarata, non silenziosa');
  } finally {
    p1.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA la scadenza che FUNZIONA: lock di 31s di un processo MORTO viene recuperato subito', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    lockConPid(p, PID_MORTO, 31000); // scaduto E proprietario inesistente
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Erede', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;

    assert.deepEqual(cellIds(out), ['Base', 'Erede'], 'il lock del morto si recupera e si scrive');
    assert.ok(durata < 2000, `recupero immediato, senza aspettare la scadenza (durata ${durata}ms)`);
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'Erede'], 'su disco');
    nessunResiduo(dir, p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA la semantica dichiarata: lock scaduto ILLEGGIBILE è trattato come abbandonato e recuperato', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    // Contenuto senza un pid interpretabile: proprietarioVivo() dice false e
    // il commento del codice lo dichiara «trattato come abbandonato».
    fs.writeFileSync(`${p}.lock`, Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x0a]), { mode: 0o600 });
    const t = (Date.now() - 31000) / 1000;
    fs.utimesSync(`${p}.lock`, t, t);

    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Ripulito', cwd: '/tmp', engine: 'sh' }]));
    assert.deepEqual(cellIds(out), ['Base', 'Ripulito'], 'il lock corrotto scaduto non blocca l avvio');
    nessunResiduo(dir, p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('contratto opts.log: il messaggio di rinuncia arriva a chi lo passa (ora cablato nei nove punti)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const altro = figlioVivo();
  try {
    atomicWrite(p, validDef());
    lockConPid(p, altro.pid); // fresco: solo attesa e rinuncia
    const messaggi = [];
    const out = aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); }, {
      log: (m) => messaggi.push(m),
    });
    assert.deepEqual(messaggi, ['definizioni fleet: lock non ottenuto, aggiornamento rimandato']);
    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia => stato corrente, senza scrivere');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
  } finally {
    altro.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA 77cff4e#2: con SharedArrayBuffer l attesa NON brucia CPU', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const altro = figlioVivo();
  try {
    atomicWrite(p, validDef());
    lockConPid(p, altro.pid);
    const cpu0 = process.cpuUsage();
    const inizio = Date.now();
    aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); });
    const cpu = process.cpuUsage(cpu0);
    const durata = Date.now() - inizio;

    assert.ok(durata >= 1900, `ha atteso ~2s (durata ${durata}ms)`);
    const cpuMs = cpu.user / 1000; // process.cpuUsage() torna microsecondi
    assert.ok(cpuMs < 700, `2s di attesa devono costare quasi zero CPU user, non ${Math.round(cpuMs)}ms`);
  } finally {
    altro.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA 77cff4e#2 (inverso): senza SharedArrayBuffer si rinuncia SUBITO — niente più busy-wait da 2s', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const altro = figlioVivo();
  const sabOriginale = globalThis.SharedArrayBuffer;
  try {
    atomicWrite(p, validDef());
    lockConPid(p, altro.pid);
    globalThis.SharedArrayBuffer = undefined; // dormiSincrono non sa più attendere
    const messaggi = [];
    const cpu0 = process.cpuUsage();
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); }, {
      log: (m) => messaggi.push(m),
    });
    const cpu = process.cpuUsage(cpu0);
    const durata = Date.now() - inizio;
    const cpuMs = cpu.user / 1000;

    assert.deepEqual(cellIds(out), ['Base'], 'degrada allo stato corrente');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(durata < 600, `rinuncia immediata, non 2s di spin (durata ${durata}ms)`);
    assert.ok(cpuMs < 300, `zero busy-wait: ${Math.round(cpuMs)}ms di CPU user`);
    assert.ok(messaggi.length === 1 && messaggi[0].includes('lock non ottenuto'), 'e la rinuncia è dichiarata');
  } finally {
    globalThis.SharedArrayBuffer = sabOriginale;
    altro.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dir non scrivibile: degrada SUBITO e senza giri di attesa (l avvio non si blocca)', () => {
  if (process.getuid && process.getuid() === 0) return; // root bypassa i permessi sulla dir
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  atomicWrite(p, validDef());
  fs.chmodSync(dir, 0o555); // sola lettura: creare il lock è impossibile
  try {
    const messaggi = [];
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]), {
      log: (m) => messaggi.push(m),
    });
    const durata = Date.now() - inizio;

    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia e torna lo stato corrente');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(durata < 600, `la rinuncia è IMMEDIATA, zero giri di attesa (durata ${durata}ms)`);
    assert.ok(messaggi.length === 1 && messaggi[0].includes('lock non ottenuto'), 'visibile se il log è cablato');
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LIVENESS caso peggiore raggiungibile in-process: lock di un morto MA unlink sempre EPERM => termina comunque a scadenza', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const lockPath = `${p}.lock`;
  const unlinkOriginale = fs.unlinkSync;
  try {
    atomicWrite(p, validDef());
    lockConPid(p, PID_MORTO, 31000);
    // sticky bit di un altro utente, ACL, o qualunque realtà in cui il lock si
    // può stat-are ma non rimuovere: il catch lo legge come «sparito nel
    // frattempo» e riprova. La scadenza dei 2s è ciò che tiene in piedi il
    // bootstrap in questo caso.
    fs.unlinkSync = (f) => {
      if (f === lockPath) {
        const e = new Error('EPERM simulato: create-without-delete');
        e.code = 'EPERM';
        throw e;
      }
      return unlinkOriginale.call(fs, f);
    };
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;

    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia e degrada');
    assert.ok(durata < 3500, `termina entro la scadenza, non appende (durata ${durata}ms)`);
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
  } finally {
    fs.unlinkSync = unlinkOriginale;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PINNA 77cff4e#3: trasforma che LANCIA non sale più di default (fail-safe) — sale solo con propaga:true', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    const messaggi = [];

    // Default (bootstrap): l'aggiornamento è opportunistico, l'avvio prosegue.
    const out = aggiornaDefinizioni(p, () => { throw new Error('boom-dal-test'); }, {
      log: (m) => messaggi.push(m),
    });
    assert.deepEqual(cellIds(out), ['Base'], 'fail-safe: torna lo stato corrente, l avvio non muore');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(messaggi.length === 1 && messaggi[0].includes('aggiornamento non riuscito') && messaggi[0].includes('boom-dal-test'),
      'l insuccesso è dichiarato col motivo');
    assert.ok(!fs.existsSync(`${p}.lock`), 'il lock è stato rilasciato: nessun orphan');

    // Chi serve una richiesta utente passa propaga:true: lì l errore va su.
    assert.throws(
      () => aggiornaDefinizioni(p, () => { throw new Error('boom-utente'); }, { propaga: true }),
      /boom-utente/,
      'con propaga:true l errore sale al chiamante',
    );
    assert.ok(!fs.existsSync(`${p}.lock`), 'lock rilasciato anche nel percorso che propaga');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
