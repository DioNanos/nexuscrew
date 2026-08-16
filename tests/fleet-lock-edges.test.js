'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadDefinitions, atomicWrite, aggiornaDefinizioni,
} = require('../lib/fleet/definitions.js');

// ---------------------------------------------------------------------------
// Dove il lock di `aggiornaDefinizioni` (fae12bc) può fare più danno del
// difetto che cura. Il lock gira nel bootstrap: lì un difetto non degrada,
// impedisce l'avvio.
//
// AMBITO DICHIARATO (le cose che questi test NON stabiliscono):
// - O_EXCL su filesystem di rete/overlay: non riproducibile su questo nodo
//   (ext4/tmpfs). «Non stabilito», non «sembra a posto».
// - Termux: non eseguito qui. «Non stabilito».
// - createBuiltinFleet end-to-end: su fae12bc `aggiornaDefinizioni` non ha
//   caller (definizione + export soltanto), quindi nessun test può dire come
//   si comporta l'avvio completo col lock. Le prove qui sono a livello di
//   helper.
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

// Un lock «di un altro»: fresco (mtime adesso) => non scaduto.
function lockFresco(p, pid = process.pid) {
  fs.writeFileSync(`${p}.lock`, `${pid}\n`, { mode: 0o600 });
}

// Un lock «di un morto» secondo l'unico criterio che il codice usa (mtime)…
// …ma intestato a un processo VIVO e riconoscibile (il nostro pid c'è scritto
// dentro: il codice non lo guarda mai).
function lockScadutoMaVivo(p, etaMs = 31000) {
  const t = (Date.now() - etaMs) / 1000;
  fs.writeFileSync(`${p}.lock`, `${process.pid}\n`, { mode: 0o600 });
  fs.utimesSync(`${p}.lock`, t, t);
}

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

test('SCELTA «scade dopo 30s» CEDDE: un lock di 31s intestato a un processo VIVO viene espropriato senza attesa', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    // Il «proprietario vivo»: il suo pid è nel lock e sta girando ADESSO.
    // Il codice non guarda il pid: guarda solo l'età del file. Dopo 30s il
    // vivo è dichiarato morto.
    lockScadutoMaVivo(p);
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Intruso', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;

    // Se il lock funzionasse, qui avremmo la rinuncia (null + defs correnti).
    // Invece: ENTRA, subito, mentre il legittimo proprietario è vivo.
    assert.deepEqual(cellIds(out), ['Base', 'Intruso'], 'il secondo processo ha scritto dentro il lock del primo');
    assert.ok(durata < 2000, `nessuna attesa: ha rubato in ${durata}ms (la rinuncia sarebbe ~2000ms)`);
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'Intruso'], 'la scrittura dell intruso è su disco');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CONSEGUENZA GRAVE: la rubata per scadenza fa perdere la scrittura che il lock doveva proteggere', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    // P1: processo VIVO, lento (fsync pigro, validazione pesante): ha preso il
    // lock 31s fa e HA GIÀ LETTO lo stato dentro il lock.
    lockScadutoMaVivo(p);
    const lettoDaP1 = loadDefinitions(p); // la lettura «dentro il lock» di P1

    // P2: arriva ora, giudica morto il vivo, ruba, scrive la sua cella.
    aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'DiP2', cwd: '/tmp', engine: 'sh' }]));
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'DiP2'], 'P2 ha scritto');

    // P1: completa la sua letti-modifica-scrivi partita da quello che aveva
    // letto DENTRO il lock (con il lock attivo, dalla sua parte, tutto regolare).
    atomicWrite(p, validDef([...lettoDaP1.cells, { id: 'DiP1', cwd: '/tmp', engine: 'sh' }]));

    // La scrittura di P2 è andata persa: il lock non ha protetto un bel nulla,
    // e questo È il difetto (perdita di scrittura concorrente) che chiudeva.
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'DiP1'],
      'la cella scritta da P2 sotto lock è SPARITA: la cura ha riaperto la malattia');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCELTA «rinuncia dopo 2s»: il messaggio arriva SOLO a chi passa opts.log — e su fae12bc nessuno lo passa', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    lockFresco(p); // di un altro, fresco: si deve solo attendere e rinunciare
    const messaggi = [];
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); }, {
      log: (m) => messaggi.push(m),
    });
    const durata = Date.now() - inizio;

    assert.ok(durata >= 1900, `ha atteso fino a scadenza (durata ${durata}ms)`);
    assert.deepEqual(messaggi, ['definizioni fleet: lock non ottenuto, aggiornamento rimandato'],
      'il contratto del callback esiste e funziona — se qualcuno lo cabla');
    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia => torna lo stato corrente, senza scrivere');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');

    // Ma il default di opts.log è una no-op e su questo commit aggiornaDefinizioni
    // NON HA CALLER (definizione + export): oggi la rinuncia è invisibile PER
    // COSTRUZIONE. Il difetto già visto oggi — «il callback c'era, e nessuno lo
    // passava» — è lo stato attuale dell'unico codice esistente.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCELTA «Atomics.wait»: con SharedArrayBuffer l attesa NON brucia CPU', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    lockFresco(p);
    const cpu0 = process.cpuUsage();
    const inizio = Date.now();
    aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); });
    const cpu = process.cpuUsage(cpu0);
    const durata = Date.now() - inizio;

    assert.ok(durata >= 1900, `ha atteso ~2s (durata ${durata}ms)`);
    const cpuMs = cpu.user / 1000; // process.cpuUsage() torna microsecondi
    assert.ok(cpuMs < 700, `2s di attesa devono costare quasi zero CPU user, non ${Math.round(cpuMs)}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCELTA «Atomics.wait» CEDDE nel ramo degradato: senza SharedArrayBuffer l attesa gira a vuoto bruciando CPU', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const sabOriginale = globalThis.SharedArrayBuffer;
  try {
    atomicWrite(p, validDef());
    lockFresco(p);
    // Simula l ambiente dove SharedArrayBuffer non c è o è disabilitato: il
    // catch di dormiSincrono lo trasforma in un no-op e il for(;;) diventa
    // busy-wait. Su Node standard SAB c è (il test sopra lo dimostra); qui si
    // prova COSA SUCCEDE dove manca, non se manca su Node.
    globalThis.SharedArrayBuffer = undefined;
    const cpu0 = process.cpuUsage();
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, () => { throw new Error('non deve scrivere'); });
    const cpu = process.cpuUsage(cpu0);
    const durata = Date.now() - inizio;

    assert.deepEqual(cellIds(out), ['Base'], 'nonostante tutto rinuncia e degrada');
    assert.ok(durata >= 1900, `termina a scadenza (durata ${durata}ms): NON appende per sempre`);
    const cpuMs = cpu.user / 1000; // process.cpuUsage() torna microsecondi
    assert.ok(cpuMs >= 1000, `i ${durata}ms di attesa sono stati SPIN: ${Math.round(cpuMs)}ms di CPU user bruciata`);
  } finally {
    globalThis.SharedArrayBuffer = sabOriginale;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCELTA «file accanto a fleet.json» CEDDE solo a metà: dir non scrivibile => degrada SUBITO, ma vedi sopra cos altro c era', () => {
  if (process.getuid && process.getuid() === 0) return; // root bypassa i permessi sulla dir
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  atomicWrite(p, validDef());
  fs.chmodSync(dir, 0o555); // sola lettura: si può creare? no
  try {
    const messaggi = [];
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]), {
      log: (m) => messaggi.push(m),
    });
    const durata = Date.now() - inizio;

    // La buona notizia, ed è quella che conta per l avvio: qui NON cede.
    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia e torna lo stato corrente');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(durata < 600, `la rinuncia è IMMEDIATA, zero giri di attesa (durata ${durata}ms)`);
    assert.deepEqual(messaggi, ['definizioni fleet: lock non ottenuto, aggiornamento rimandato'],
      'e la rinuncia è visibile — se qualcuno passa opts.log');
    // La metà che cede è la visibilità del default no-op: vedi il test sopra.
    // La rinuncia «silenziosa» su backfill mai eseguito resta invisibile finché
    // i sette punti non cablano il log.
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LIVENESS caso peggiore raggiungibile in-process: lock scaduto MA unlink sempre EPERM => termina comunque a scadenza', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const lockPath = `${p}.lock`;
  const unlinkOriginale = fs.unlinkSync;
  try {
    atomicWrite(p, validDef());
    lockScadutoMaVivo(p);
    // dir con sticky bit di un altro utente, ACL, o qualunque realtà in cui il
    // lock si può stat-are ma non rimuovere: il catch lo legge come «sparito
    // nel frattempo» e riprova all infinito. La scadenza dei 2s è l unica cosa
    // che tiene in piedi il bootstrap in questo caso.
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

test('trasforma che LANCIA: il lock viene rilasciato (finally) ma l errore SALE — chi cabla i sette punti nel bootstrap deve decidere', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    assert.throws(
      () => aggiornaDefinizioni(p, () => { throw new Error('boom-dal-test'); }),
      /boom-dal-test/,
      'l errore di trasforma attraversa aggiornaDefinizioni',
    );
    assert.ok(!fs.existsSync(`${p}.lock`), 'il lock è stato rilasciato: nessun orphan');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    // Nel bootstrap un throw non catturato = avvio che non parte. La scelta
    // «degradare o morire» per i sette punti è di chi li cabla: qui si mette
    // nero su bianco che l helper NON decide da solo.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
